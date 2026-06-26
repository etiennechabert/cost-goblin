//! S3 CUR download sync, ported from the desktop `handlers/sync.ts` +
//! `@costgoblin/core` sync modules.
//!
//! Like Electron, the bulk download shells out to the **`aws s3 sync` CLI** —
//! it reuses the user's SSO session, handles multipart + incremental skips, and
//! is far more robust than a hand-rolled SDK download. The AWS SDK is used only
//! for the *remote inventory* listing (ListObjectsV2) that drives the Data
//! Management UI. Files land directly in `aws/raw/{tier}-{period}/` — there is
//! no repartitioning step.
//!
//! Progress is reported through a shared status map keyed by syncId (= tier),
//! which the renderer polls via `get_sync_status` (mirrors Electron's
//! `state.syncStatuses[syncId]` + `sync:status`).

use aws_sdk_s3::config::Region;
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Map, Value as J};
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// --- shared state: per-syncId status + cancel flags ---

fn status_map() -> &'static Mutex<HashMap<String, J>> {
    static M: OnceLock<Mutex<HashMap<String, J>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cancel_map() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}
fn set_status(sync_id: &str, status: J) {
    status_map().lock().unwrap().insert(sync_id.to_string(), status);
}
pub fn status(sync_id: &str) -> J {
    status_map().lock().unwrap().get(sync_id).cloned().unwrap_or_else(|| json!({ "status": "idle", "lastSync": null }))
}
pub fn cancel(sync_id: &str) {
    if let Some(flag) = cancel_map().lock().unwrap().get(sync_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

// --- key/period helpers (ported from sync-utils.ts) ---

pub fn parse_s3_path(s: &str) -> (String, String) {
    let stripped = s.strip_prefix("s3://").unwrap_or(s);
    match stripped.find('/') {
        Some(i) => (stripped[..i].to_string(), stripped[i + 1..].to_string()),
        None => (stripped.to_string(), String::new()),
    }
}

fn raw_dir_prefix(tier: &str) -> &'static str {
    match tier {
        "hourly" => "hourly",
        "cost-optimization" => "cost-opt",
        _ => "daily",
    }
}
fn etag_file_name(tier: &str) -> &'static str {
    match tier {
        "hourly" => "sync-etags-hourly.json",
        "cost-optimization" => "sync-etags-cost-optimization.json",
        _ => "sync-etags.json",
    }
}

fn extract_period(key: &str) -> String {
    if let Some(i) = key.find("BILLING_PERIOD=") {
        let s = &key[i + "BILLING_PERIOD=".len()..];
        if s.len() >= 7 {
            return s[..7].to_string();
        }
    }
    if let Some(i) = key.find("date=") {
        let s = &key[i + "date=".len()..];
        if s.len() >= 7 {
            return s[..7].to_string();
        }
    }
    "unknown".to_string()
}

fn extract_period_prefix(key: &str) -> String {
    if let Some(i) = key.find("BILLING_PERIOD=") {
        let after = i + "BILLING_PERIOD=".len() + 7; // past YYYY-MM
        if after <= key.len() {
            if let Some(slash) = key[after..].find('/') {
                return key[..after + slash + 1].to_string();
            }
        }
    }
    if let Some(i) = key.find("date=") {
        let after = i + "date=".len() + 10; // past YYYY-MM-DD
        if after <= key.len() {
            if let Some(slash) = key[after..].find('/') {
                return key[..after + slash + 1].to_string();
            }
        }
    }
    String::new()
}

fn extract_date(key: &str) -> Option<String> {
    let i = key.find("date=")?;
    let s = &key[i + "date=".len()..];
    if s.len() >= 10 {
        Some(s[..10].to_string())
    } else {
        None
    }
}

/// Parse an `aws s3 sync` "Completed X MiB/Y MiB ..." line into (done, total).
fn parse_completed_bytes(line: &str) -> Option<(f64, f64)> {
    let rest = line.strip_prefix("Completed ")?;
    let mut it = rest.split_whitespace();
    let done_num: f64 = it.next()?.parse().ok()?;
    let done_unit = it.next()?; // "MiB/404.2"  → unit then "/total"
    // form is "203.6 MiB/404.2 MiB" — after splitting, token2 = "MiB/404.2"
    let (done_u, total_part) = done_unit.split_once('/')?;
    let total_num: f64 = total_part.parse().ok()?;
    let total_u = it.next()?;
    let factor = |u: &str| -> Option<f64> {
        Some(match u {
            "B" => 1.0,
            "KiB" => 1024.0,
            "MiB" => 1024.0 * 1024.0,
            "GiB" => 1024.0 * 1024.0 * 1024.0,
            "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
            _ => return None,
        })
    };
    let bd = done_num * factor(done_u)?;
    let bt = total_num * factor(total_u)?;
    if bt <= 0.0 || !bd.is_finite() || !bt.is_finite() {
        return None;
    }
    Some((bd, bt))
}

// --- etag persistence ({ period: { key: contentHash } }) ---

fn save_etags(data_dir: &str, tier: &str, period: &str, period_files: &[(String, String)]) -> Result<(), String> {
    let path = Path::new(data_dir).join(etag_file_name(tier));
    let mut saved: J = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
    let obj = saved.as_object_mut().ok_or("etag file not an object")?;
    let mut period_map = Map::new();
    for (key, hash) in period_files {
        period_map.insert(key.clone(), json!(hash));
    }
    obj.insert(period.to_string(), J::Object(period_map));
    std::fs::write(&path, serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?).map_err(|e| format!("write {}: {e}", path.display()))
}

// --- AWS CLI discovery (matches selective-sync.ts findAwsCli) ---

pub fn find_aws_cli() -> String {
    for p in ["/opt/homebrew/bin/aws", "/usr/local/bin/aws", "/usr/bin/aws", "/usr/local/sbin/aws", "/opt/local/bin/aws"] {
        if Path::new(p).exists() {
            return p.to_string();
        }
    }
    "aws".to_string()
}

// --- the download (CLI per period) ---

struct LineState {
    files_total: u64,
    files_done: u64,
    bytes_done: Option<f64>,
    bytes_total: Option<f64>,
}

fn run_aws_s3_sync(source: &str, dest: &Path, profile: &str, cancel_flag: &Arc<AtomicBool>, sync_id: &str, ls: &mut LineState) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let aws = find_aws_cli();
    let mut child = Command::new(&aws)
        .args(["s3", "sync", source, &dest.to_string_lossy(), "--profile", profile])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "AWS CLI not found — install it with: brew install awscli".to_string() } else { format!("spawn aws: {e}") })?;

    // Drain stderr on a side thread so a full pipe can't deadlock us.
    let stderr = child.stderr.take();
    let err_buf = Arc::new(Mutex::new(String::new()));
    let err_buf2 = err_buf.clone();
    let err_thread = stderr.map(|mut e| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = e.read_to_string(&mut s);
            *err_buf2.lock().unwrap() = s;
        })
    });

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut buf = [0u8; 8192];
    let mut pending = String::new();
    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(t) = err_thread {
                let _ = t.join();
            }
            return Err("Download cancelled".to_string());
        }
        let n = stdout.read(&mut buf).map_err(|e| format!("read aws stdout: {e}"))?;
        if n == 0 {
            break;
        }
        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
        // aws progress uses \r; split on both so "Completed" lines surface.
        let mut parts: Vec<&str> = pending.split(['\n', '\r']).collect();
        let tail = parts.pop().unwrap_or("").to_string();
        for line in parts {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            handle_line(t, ls);
            emit_progress(sync_id, ls, if t.starts_with("Completed") { Some(t) } else { None });
        }
        pending = tail;
    }

    let code = child.wait().map_err(|e| format!("wait aws: {e}"))?;
    if let Some(t) = err_thread {
        let _ = t.join();
    }
    if cancel_flag.load(Ordering::SeqCst) {
        return Err("Download cancelled".to_string());
    }
    if code.success() {
        Ok(())
    } else {
        let stderr = err_buf.lock().unwrap().trim().to_string();
        Err(format!("aws s3 sync failed (exit {}): {}", code.code().unwrap_or(-1), stderr))
    }
}

fn handle_line(line: &str, ls: &mut LineState) {
    if line.starts_with("download:") {
        ls.files_done += 1;
    }
    if line.starts_with("Completed") {
        if let Some((bd, bt)) = parse_completed_bytes(line) {
            ls.bytes_done = Some(bd);
            ls.bytes_total = Some(bt);
        }
    }
}

fn emit_progress(sync_id: &str, ls: &LineState, message: Option<&str>) {
    let bd = ls.bytes_done.unwrap_or(0.0);
    let bt = ls.bytes_total.unwrap_or(0.0);
    let fraction = if bt > 0.0 {
        bd / bt
    } else if ls.files_total > 0 {
        ls.files_done as f64 / ls.files_total as f64
    } else {
        0.0
    };
    set_status(sync_id, json!({
        "status": "syncing", "phase": "downloading", "progress": fraction,
        "filesTotal": ls.files_total, "filesDone": ls.files_done,
        "bytesTotal": bt, "bytesDone": bd, "message": message.unwrap_or(""),
    }));
}

/// Download the selected files (grouped by period) via `aws s3 sync`. `files`
/// is the manifest subset the user chose: `[{ key, contentHash, size }]`.
pub fn sync_periods(files: &[J], tier: &str, profile: &str, bucket_path: &str, data_dir: &str, sync_id: &str) -> Result<(u64, u64), String> {
    let (bucket, _prefix) = parse_s3_path(bucket_path);
    let cancel_flag = Arc::new(AtomicBool::new(false));
    cancel_map().lock().unwrap().insert(sync_id.to_string(), cancel_flag.clone());
    let total_files = files.len() as u64;
    set_status(sync_id, json!({ "status": "syncing", "phase": "downloading", "progress": 0.0, "filesTotal": total_files, "filesDone": 0, "bytesTotal": 0, "bytesDone": 0, "message": "" }));

    let result = if tier == "cost-optimization" {
        sync_cost_opt(files, &bucket, profile, data_dir, sync_id, &cancel_flag)
    } else {
        sync_standard(files, tier, &bucket, profile, data_dir, sync_id, &cancel_flag)
    };

    cancel_map().lock().unwrap().remove(sync_id);
    match result {
        Ok(n) => {
            set_status(sync_id, json!({ "status": "completed", "lastSync": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true), "filesDownloaded": n }));
            Ok((n, 0))
        }
        Err(e) if e == "Download cancelled" => {
            set_status(sync_id, json!({ "status": "idle", "lastSync": null }));
            Ok((0, 0))
        }
        Err(e) => {
            set_status(sync_id, json!({ "status": "failed", "error": { "message": e.clone() }, "lastSync": null }));
            Err(e)
        }
    }
}

/// group files by extract_period, preserving the manifest entries.
fn group_by_period(files: &[J]) -> Vec<(String, Vec<J>)> {
    let mut groups: Vec<(String, Vec<J>)> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    for f in files {
        let key = f.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let period = extract_period(key);
        match index.get(&period) {
            Some(&i) => groups[i].1.push(f.clone()),
            None => {
                index.insert(period.clone(), groups.len());
                groups.push((period, vec![f.clone()]));
            }
        }
    }
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    groups
}

fn period_etag_pairs(period_files: &[J]) -> Vec<(String, String)> {
    period_files.iter().map(|f| (
        f.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        f.get("contentHash").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    )).collect()
}

fn sync_standard(files: &[J], tier: &str, bucket: &str, profile: &str, data_dir: &str, sync_id: &str, cancel_flag: &Arc<AtomicBool>) -> Result<u64, String> {
    let mut downloaded = 0u64;
    let mut ls = LineState { files_total: files.len() as u64, files_done: 0, bytes_done: None, bytes_total: None };
    for (period, period_files) in group_by_period(files) {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Download cancelled".to_string());
        }
        let first_key = period_files.first().and_then(|f| f.get("key")).and_then(|v| v.as_str()).unwrap_or("");
        let prefix = extract_period_prefix(first_key);
        let source = format!("s3://{bucket}/{prefix}");
        let staging = PathBuf::from(data_dir).join("aws").join("raw").join(format!("{tier}-{period}"));
        std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir {}: {e}", staging.display()))?;
        run_aws_s3_sync(&source, &staging, profile, cancel_flag, sync_id, &mut ls)?;
        downloaded += period_files.len() as u64;
        save_etags(data_dir, tier, &period, &period_etag_pairs(&period_files))?;
    }
    Ok(downloaded)
}

fn sync_cost_opt(files: &[J], bucket: &str, profile: &str, data_dir: &str, sync_id: &str, cancel_flag: &Arc<AtomicBool>) -> Result<u64, String> {
    let output_dir = PathBuf::from(data_dir).join("aws").join("cost-optimization");
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("mkdir {}: {e}", output_dir.display()))?;
    let mut downloaded = 0u64;
    let mut ls = LineState { files_total: files.len() as u64, files_done: 0, bytes_done: None, bytes_total: None };
    for (period, period_files) in group_by_period(files) {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Download cancelled".to_string());
        }
        // group this period's files by exact date
        let mut by_date: Vec<(String, Vec<J>)> = vec![];
        let mut idx: HashMap<String, usize> = HashMap::new();
        for f in &period_files {
            let key = f.get("key").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(date) = extract_date(key) {
                match idx.get(&date) {
                    Some(&i) => by_date[i].1.push(f.clone()),
                    None => { idx.insert(date.clone(), by_date.len()); by_date.push((date, vec![f.clone()])); }
                }
            }
        }
        for (date, date_files) in by_date {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Download cancelled".to_string());
            }
            let first_key = date_files.first().and_then(|f| f.get("key")).and_then(|v| v.as_str()).unwrap_or("");
            let prefix = extract_period_prefix(first_key);
            let source = format!("s3://{bucket}/{prefix}");
            let staging = PathBuf::from(data_dir).join("aws").join("raw").join(format!("cost-opt-{date}"));
            std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir {}: {e}", staging.display()))?;
            run_aws_s3_sync(&source, &staging, profile, cancel_flag, sync_id, &mut ls)?;
            // copy the parquet into the hive-partitioned cost-optimization dir
            let date_dir = output_dir.join(format!("usage_date={date}"));
            std::fs::create_dir_all(&date_dir).map_err(|e| format!("mkdir {}: {e}", date_dir.display()))?;
            if let Ok(entries) = std::fs::read_dir(&staging) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("parquet") {
                        let _ = std::fs::copy(&p, date_dir.join("data.parquet"));
                    }
                }
            }
            downloaded += date_files.len() as u64;
        }
        save_etags(data_dir, "cost-optimization", &period, &period_etag_pairs(&period_files))?;
    }
    Ok(downloaded)
}

// --- delete a local period (ported from data:delete-period) ---

pub fn delete_local_period(period: &str, tier: &str, data_dir: &str) -> Result<(), String> {
    let prefix = raw_dir_prefix(tier);
    let raw_dir = PathBuf::from(data_dir).join("aws").join("raw");
    if let Ok(entries) = std::fs::read_dir(&raw_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == format!("{prefix}-{period}") || name.starts_with(&format!("{prefix}-{period}-")) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    // prune the etag file
    let etag_path = raw_dir.parent().map(|_| PathBuf::from(data_dir).join(etag_file_name(tier)));
    if let Some(path) = etag_path {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(mut v) = serde_json::from_str::<J>(&raw) {
                if let Some(obj) = v.as_object_mut() {
                    obj.retain(|k, _| k != period && !k.starts_with(&format!("{period}-")));
                    let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
                }
            }
        }
    }
    Ok(())
}

// --- retention / prune (ported from core retention.ts) ---

/// Local YYYY-MM periods present for a tier (deduped, sorted).
fn list_local_periods(data_dir: &str, tier: &str) -> Vec<String> {
    let prefix = raw_dir_prefix(tier);
    let raw_dir = PathBuf::from(data_dir).join("aws").join("raw");
    let mut set = BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(&raw_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix(&format!("{prefix}-")) {
                let period: String = rest.chars().take(7).collect();
                if period.len() == 7 {
                    set.insert(period);
                }
            }
        }
    }
    set.into_iter().collect()
}

/// Earliest month still inside the retention window — periods strictly older are
/// pruned (matches the auto-sync download cutoff).
fn retention_cutoff(retention_days: i64) -> String {
    (Utc::now() - Duration::days(retention_days)).format("%Y-%m").to_string()
}

/// Delete every local period outside each configured tier's retention window.
/// Returns `{ deleted: [{ tier, period }] }`.
pub fn prune_now(data_dir: &str, config_dir: &Path) -> Result<J, String> {
    let cfg = crate::config::load_yaml_json(&config_dir.join("costgoblin.yaml"))?;
    let sync = cfg.get("providers").and_then(|p| p.as_array()).and_then(|a| a.first()).and_then(|p| p.get("sync")).cloned().unwrap_or_else(|| json!({}));
    let mut deleted = vec![];
    // (tier, config-key, default-days, configured)
    let tiers = [
        ("daily", "daily", 365i64, true),
        ("hourly", "hourly", 30, sync.get("hourly").is_some()),
        ("cost-optimization", "costOptimization", 90, sync.get("costOptimization").is_some()),
    ];
    for (tier, key, default_days, configured) in tiers {
        if !configured {
            continue;
        }
        let days = sync.get(key).and_then(|t| t.get("retentionDays")).and_then(|v| v.as_i64()).unwrap_or(default_days);
        if days <= 0 {
            continue; // guard: never treat 0/negative as "everything expired"
        }
        let cutoff = retention_cutoff(days);
        for period in list_local_periods(data_dir, tier) {
            if period < cutoff {
                delete_local_period(&period, tier, data_dir)?;
                deleted.push(json!({ "tier": tier, "period": period }));
            }
        }
    }
    Ok(json!({ "deleted": deleted }))
}

// --- remote inventory via S3 ListObjectsV2 (drives the sync UI) ---

pub async fn remote_inventory(bucket_path: &str, profile: &str, data_dir: &str, tier: &str) -> Result<J, String> {
    let (bucket, prefix) = parse_s3_path(bucket_path);
    let conf = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .profile_name(profile.to_string())
        .region(Region::new("eu-central-1"))
        .load()
        .await;
    let client = aws_sdk_s3::Client::new(&conf);

    // list all .parquet under the prefix
    let mut remote: Vec<(String, String, i64)> = vec![]; // key, etag, size
    let mut token: Option<String> = None;
    loop {
        let resp = client
            .list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .set_continuation_token(token.clone())
            .send()
            .await
            .map_err(|e| format!("s3:ListObjectsV2 failed (check `aws sso login --profile {profile}`): {}", aws_smithy_types::error::display::DisplayErrorContext(&e)))?;
        for obj in resp.contents() {
            if let Some(key) = obj.key() {
                if key.ends_with(".parquet") {
                    remote.push((key.to_string(), obj.e_tag().unwrap_or("").to_string(), obj.size().unwrap_or(0)));
                }
            }
        }
        if resp.is_truncated().unwrap_or(false) {
            token = resp.next_continuation_token().map(|s| s.to_string());
            if token.is_none() {
                break;
            }
        } else {
            break;
        }
    }

    // group remote by period
    let mut period_files: HashMap<String, Vec<(String, String, i64)>> = HashMap::new();
    let mut order: Vec<String> = vec![];
    for (key, etag, size) in &remote {
        let period = extract_period(key);
        if period == "unknown" {
            continue;
        }
        if !period_files.contains_key(&period) {
            order.push(period.clone());
        }
        period_files.entry(period).or_default().push((key.clone(), etag.clone(), *size));
    }

    // local periods + saved etags
    let local = local_inventory(data_dir, tier);
    let local_periods: Vec<String> = local["local"]["periods"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let etag_path = PathBuf::from(data_dir).join(etag_file_name(tier));
    let saved: J = std::fs::read_to_string(&etag_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));

    let status_of = |period: &str, files: &[(String, String, i64)]| -> &'static str {
        if !local_periods.iter().any(|p| p == period) {
            return "missing";
        }
        let saved_period = saved.get(period);
        for (key, etag, _) in files {
            let matches = saved_period.and_then(|sp| sp.get(key)).and_then(|v| v.as_str()) == Some(etag.as_str());
            if !matches {
                return "stale";
            }
        }
        "repartitioned"
    };

    order.sort_by(|a, b| b.cmp(a)); // newest first
    let mut total_remote_size: i64 = 0;
    let periods: Vec<J> = order
        .iter()
        .map(|period| {
            let files = &period_files[period];
            let total: i64 = files.iter().map(|(_, _, s)| *s).sum();
            total_remote_size += total;
            let files_json: Vec<J> = files.iter().map(|(k, e, s)| json!({ "key": k, "contentHash": e, "size": s })).collect();
            json!({ "period": period, "files": files_json, "totalSize": total, "localStatus": status_of(period, files) })
        })
        .collect();

    Ok(json!({
        "periods": periods,
        "totalRemoteSize": total_remote_size,
        "totalLocalPeriods": local_periods.len(),
        "totalRemotePeriods": periods.len(),
        "local": local["local"].clone(),
    }))
}

/// Local-only inventory (offline fallback) — mirrors the previous behavior:
/// lists local period dirs, sums disk bytes, marks present periods.
pub fn local_inventory(data_dir: &str, tier: &str) -> J {
    let prefix = raw_dir_prefix(tier);
    let raw_dir = PathBuf::from(data_dir).join("aws").join("raw");
    let mut months: Vec<String> = vec![];
    let mut disk_bytes: u64 = 0;
    let mut periods: Vec<J> = vec![];
    let mut seen = std::collections::BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(&raw_dir) {
        let mut dirs: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with(&format!("{prefix}-"))).collect();
        dirs.sort();
        for name in dirs {
            let period = name[prefix.len() + 1..].chars().take(7).collect::<String>();
            if period.len() != 7 {
                continue;
            }
            let dir = raw_dir.join(&name);
            let mut total: u64 = 0;
            let mut files = vec![];
            if let Ok(es) = std::fs::read_dir(&dir) {
                for e in es.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("parquet") {
                        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                        total += size;
                        files.push(json!({ "key": p.file_name().and_then(|s| s.to_str()).unwrap_or(""), "contentHash": "", "size": size }));
                    }
                }
            }
            if files.is_empty() {
                continue;
            }
            disk_bytes += total;
            if seen.insert(period.clone()) {
                months.push(period.clone());
            }
            periods.push(json!({ "period": period, "files": files, "totalSize": total, "localStatus": "repartitioned" }));
        }
    }
    json!({
        "periods": periods, "totalRemoteSize": disk_bytes,
        "totalLocalPeriods": months.len(), "totalRemotePeriods": months.len(),
        "local": {
            "periods": months, "diskBytes": disk_bytes,
            "oldestPeriod": months.first().cloned().map(J::String).unwrap_or(J::Null),
            "newestPeriod": months.last().cloned().map(J::String).unwrap_or(J::Null),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn period_extraction() {
        assert_eq!(extract_period("a/BILLING_PERIOD=2026-04/x.parquet"), "2026-04");
        assert_eq!(extract_period("cur/date=2026-04-08/data.parquet"), "2026-04");
        assert_eq!(extract_period_prefix("a/BILLING_PERIOD=2026-04/x.parquet"), "a/BILLING_PERIOD=2026-04/");
        assert_eq!(extract_period_prefix("cur/date=2026-04-08/d.parquet"), "cur/date=2026-04-08/");
        assert_eq!(extract_date("cur/date=2026-04-08/d.parquet").as_deref(), Some("2026-04-08"));
    }

    #[test]
    fn completed_bytes_parsing() {
        assert_eq!(parse_completed_bytes("Completed 203.6 MiB/404.2 MiB (3.0 MiB/s) with 7 file(s) remaining"), Some((203.6 * 1048576.0, 404.2 * 1048576.0)));
        assert_eq!(parse_completed_bytes("Completed 5 file(s) with 2 remaining"), None);
    }

    #[test]
    fn s3_path_parsing() {
        assert_eq!(parse_s3_path("s3://my-bucket/cur/prefix"), ("my-bucket".to_string(), "cur/prefix".to_string()));
        assert_eq!(parse_s3_path("just-bucket"), ("just-bucket".to_string(), String::new()));
    }
}
