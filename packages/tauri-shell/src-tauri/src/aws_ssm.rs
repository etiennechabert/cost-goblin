//! Real AWS SSM region-name enrichment, ported from the desktop
//! `aws-ssm-client.ts` + the `ssm:*` / `org:get-region-names-info` handlers.
//!
//! AWS publishes per-region metadata as public SSM parameters under
//! `/aws/service/global-infrastructure/regions/<code>/<field>`. We list the
//! region codes, then batch-fetch longName/country/continent (10 names per
//! GetParameters call), and cache the result as `region-names.json` next to the
//! data dir — the same shape Electron writes (`{ syncedAt, regions }`).

use aws_sdk_ssm::config::Region;
use aws_sdk_ssm::Client;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Most-recent sync failure reason — mirrors Electron's in-memory
/// `lastRegionSyncError` so `get_region_names_info` can hint at the cause.
fn last_error() -> &'static Mutex<Option<String>> {
    static E: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(None))
}
fn set_last_error(v: Option<String>) {
    *last_error().lock().unwrap() = v;
}

const FIELDS: [&str; 3] = ["longName", "geolocationCountry", "geolocationRegion"];
const REGIONS_PATH: &str = "/aws/service/global-infrastructure/regions";

/// Parse `~/.aws/config` into sections keyed like the smithy shared-config
/// loader: bare profile names, and `sso-session.<name>` for sso-session blocks.
fn load_aws_config_sections() -> HashMap<String, HashMap<String, String>> {
    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    let home = std::env::var("HOME").unwrap_or_default();
    let Ok(text) = std::fs::read_to_string(format!("{home}/.aws/config")) else { return out };
    let mut current: Option<String> = None;
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with(';') {
            continue;
        }
        if l.starts_with('[') && l.ends_with(']') {
            let inner = l[1..l.len() - 1].trim();
            let key = if let Some(rest) = inner.strip_prefix("profile ") {
                rest.trim().to_string()
            } else if let Some(rest) = inner.strip_prefix("sso-session ") {
                format!("sso-session.{}", rest.trim())
            } else {
                inner.to_string()
            };
            current = Some(key.clone());
            out.entry(key).or_default();
        } else if let Some(sec) = &current {
            if let Some((k, v)) = l.split_once('=') {
                out.get_mut(sec).unwrap().insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    out
}

/// Region for a profile: its own `region`, else its sso-session's `sso_region`.
/// Must be passed explicitly — AWS_REGION env precedence would otherwise hit a
/// region the org's SCP may deny.
fn resolve_profile_region(profile: &str) -> Result<String, String> {
    let cfg = load_aws_config_sections();
    let section = cfg.get(profile).cloned().unwrap_or_default();
    if let Some(r) = section.get("region").filter(|s| !s.is_empty()) {
        return Ok(r.clone());
    }
    if let Some(sso) = section.get("sso_session").filter(|s| !s.is_empty()) {
        if let Some(r) = cfg.get(&format!("sso-session.{sso}")).and_then(|s| s.get("sso_region")).filter(|s| !s.is_empty()) {
            return Ok(r.clone());
        }
    }
    Err(format!("Profile \"{profile}\" has no region configured in ~/.aws/config. Add 'region = <aws-region>' to the profile."))
}

fn apply_param(partial: &mut HashMap<String, (String, String, String)>, name: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    let parts: Vec<&str> = name.split('/').collect();
    let n = parts.len();
    if n < 2 {
        return;
    }
    let code = parts[n - 2];
    let field = parts[n - 1];
    if code.is_empty() {
        return;
    }
    let entry = partial.entry(code.to_string()).or_default();
    match field {
        "longName" => entry.0 = value.to_string(),
        "geolocationCountry" => entry.1 = value.to_string(),
        "geolocationRegion" => entry.2 = value.to_string(),
        _ => {}
    }
}

/// Fetch region metadata from SSM and cache it. Returns `{ syncedAt, regions }`.
pub async fn sync(profile: &str, data_dir: &Path) -> Result<Value, String> {
    match sync_inner(profile, data_dir).await {
        Ok(v) => {
            set_last_error(None);
            Ok(v)
        }
        Err(e) => {
            set_last_error(Some(e.clone()));
            Err(e)
        }
    }
}

async fn sync_inner(profile: &str, data_dir: &Path) -> Result<Value, String> {
    let region = resolve_profile_region(profile)?;
    let conf = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .profile_name(profile.to_string())
        .region(Region::new(region))
        .load()
        .await;
    let client = Client::new(&conf);

    // 1) list region codes
    let mut codes: Vec<String> = vec![];
    let mut tok: Option<String> = None;
    loop {
        let resp = client
            .get_parameters_by_path()
            .path(REGIONS_PATH)
            .set_next_token(tok.clone())
            .send()
            .await
            .map_err(|e| {
                format!(
                    "ssm:GetParametersByPath failed (check `aws sso login --profile {profile}` + ssm perms): {}",
                    aws_smithy_types::error::display::DisplayErrorContext(&e)
                )
            })?;
        for p in resp.parameters() {
            if let Some(name) = p.name() {
                let last = name.rsplit('/').next().unwrap_or("");
                if !last.is_empty() {
                    codes.push(last.to_string());
                }
            }
        }
        match resp.next_token() {
            Some(t) => tok = Some(t.to_string()),
            None => break,
        }
    }

    // 2) batch the per-field lookups (10 names per GetParameters call)
    let mut all_names: Vec<String> = vec![];
    for c in &codes {
        for f in FIELDS {
            all_names.push(format!("{REGIONS_PATH}/{c}/{f}"));
        }
    }
    let mut partial: HashMap<String, (String, String, String)> = HashMap::new();
    for batch in all_names.chunks(10) {
        match client.get_parameters().set_names(Some(batch.to_vec())).send().await {
            Ok(resp) => {
                for p in resp.parameters() {
                    apply_param(&mut partial, p.name().unwrap_or(""), p.value().unwrap_or(""));
                }
            }
            Err(_) => continue, // tolerate per-batch failures (matches desktop)
        }
    }

    // 3) keep only regions with a longName (display is mandatory)
    let mut regions = Map::new();
    for (code, (long_name, country, continent)) in partial {
        if long_name.is_empty() {
            continue;
        }
        regions.insert(code, json!({ "longName": long_name, "country": country, "continent": continent }));
    }

    let synced_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let map = json!({ "syncedAt": synced_at, "regions": Value::Object(regions) });

    let base = data_dir.parent().ok_or("data dir has no parent")?;
    std::fs::write(base.join("region-names.json"), serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write region-names.json: {e}"))?;
    Ok(map)
}

/// `{ count, syncedAt, lastError, regions }` for the Data Management card, or
/// Null when there's no cache and no prior error.
pub fn read_info(data_dir: &Path) -> Value {
    let base = match data_dir.parent() {
        Some(b) => b,
        None => return Value::Null,
    };
    let err = last_error().lock().unwrap().clone();
    match std::fs::read_to_string(base.join("region-names.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        Some(v) => {
            let synced_at = v.get("syncedAt").and_then(|x| x.as_str()).unwrap_or("");
            let mut out = Map::new();
            if let Some(regions) = v.get("regions").and_then(|r| r.as_object()) {
                for (code, info) in regions {
                    let long_name = info.get("longName").and_then(|x| x.as_str()).unwrap_or("");
                    if long_name.is_empty() {
                        continue;
                    }
                    out.insert(code.clone(), json!({
                        "longName": long_name,
                        "country": info.get("country").and_then(|x| x.as_str()).unwrap_or(""),
                        "continent": info.get("continent").and_then(|x| x.as_str()).unwrap_or(""),
                    }));
                }
            }
            json!({ "count": out.len(), "syncedAt": synced_at, "lastError": err, "regions": Value::Object(out) })
        }
        None => match err {
            Some(e) => json!({ "count": 0, "syncedAt": "", "lastError": e, "regions": {} }),
            None => Value::Null,
        },
    }
}

/// Wipe everything the org/region sync produced (idempotent).
pub fn clear(data_dir: &Path) {
    if let Some(base) = data_dir.parent() {
        for f in ["org-accounts.json", "org-account-tags.json", "region-names.json"] {
            let _ = std::fs::remove_file(base.join(f));
        }
    }
    set_last_error(None);
}
