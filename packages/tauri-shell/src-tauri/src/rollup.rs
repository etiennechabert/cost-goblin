//! Rollup READ path — routes dashboard queries to the pre-aggregated per-period
//! rollup partitions Electron's rollup-store builds, instead of scanning raw
//! CUR parquet. Ported from `@costgoblin/core` rollup/* + the desktop
//! `query-utils.resolveRollupSource` routing.
//!
//! Layout (built by Electron 0.4.x, read here):
//!   {DATA_DIR}/aws/rollup/manifest.json
//!   {DATA_DIR}/aws/rollup/daily-YYYY-MM/rollup.parquet
//!
//! A rollup partition has the grain dimension columns + `usage_date` plus a
//! pre-summed `cost` (DOUBLE, baked with the configured metric/perspective and
//! cost-scope exclusions) and `line_items` (BIGINT). So a query that groups by
//! in-grain columns just SUMs the pre-summed `cost` over the small partition —
//! no org join, no exclusions, no metric CASE at query time.

use crate::config::{CostScope, Dimensions};
use crate::query::sql_escape;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const ROLLUP_SCHEMA_VERSION: i64 = 1;

// --- canonical JSON + sha256 (mirror core digest.ts) ---

/// Deterministic JSON: object keys sorted recursively, arrays preserve order,
/// compact. Mirrors `canonicalJson` so digests are stable.
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canonical_json(&o[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let d = h.finalize();
    let mut out = String::with_capacity(64);
    for b in d {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Per-period raw-etag watermark: sha256 over the canonical JSON of the period's
/// `{fileKey: contentHash}` map. Validated empirically against the on-disk value.
pub fn partition_etag_hash(period_etags: &Value) -> String {
    sha256_hex(&canonical_json(period_etags))
}

/// Digest over the org-accounts fields baked into the tag-fallback projection
/// (id, ouPath, tags) — name excluded (query-time). Sorted for stability.
fn org_accounts_digest(data_dir: &str) -> String {
    let base = match Path::new(data_dir).parent() {
        Some(b) => b,
        None => return sha256_hex("empty"),
    };
    let raw = match std::fs::read_to_string(base.join("org-accounts.json")) {
        Ok(r) => r,
        Err(_) => return sha256_hex("empty"),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return sha256_hex("invalid"),
    };
    let Some(accounts) = parsed.get("accounts").and_then(|a| a.as_array()) else { return sha256_hex("empty") };
    let mut norm: Vec<Value> = accounts
        .iter()
        .filter_map(|a| {
            let id = a.get("id").and_then(|x| x.as_str())?.to_string();
            let ou_path = a.get("ouPath").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let mut tags = Map::new();
            if let Some(t) = a.get("tags").and_then(|x| x.as_object()) {
                for (k, v) in t {
                    if let Some(s) = v.as_str() {
                        tags.insert(k.clone(), json!(s));
                    }
                }
            }
            Some(json!({ "id": id, "ouPath": ou_path, "tags": Value::Object(tags) }))
        })
        .collect();
    norm.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
    sha256_hex(&canonical_json(&Value::Array(norm)))
}

// --- shape signature (mirror core shape-signature.ts) ---

/// The shape-affecting digest: only inputs that change the BYTES stored in a
/// partition. Self-consistent (build writes it, read validates it); structurally
/// mirrors Electron's so it stays close to cross-compatible.
pub fn compute_shape_signature(dims: &Dimensions, cs: &CostScope, available_columns: &[String], org_digest: &str) -> String {
    let mut builtin_dims: Vec<Value> = dims
        .built_in
        .iter()
        .filter(|d| d.enabled != Some(false))
        .map(|d| json!({ "kind": "builtin", "name": d.name, "field": d.field }))
        .collect();
    builtin_dims.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));

    let mut tag_dims: Vec<Value> = dims
        .tags
        .iter()
        .filter(|t| t.enabled != Some(false))
        .map(|t| json!({
            "kind": "tag",
            "column": crate::query::tag_dim_column(t),
            "tagName": t.tag_name.clone().map(Value::String).unwrap_or(Value::Null),
            "accountTagFallback": t.account_tag_fallback.clone().map(Value::String).unwrap_or(Value::Null),
            "missingValueTemplate": t.missing_value_template.clone().map(Value::String).unwrap_or(Value::Null),
            "pathSegment": t.path_segment.as_ref().map(|p| json!({ "separator": p.separator, "index": p.index })).unwrap_or(Value::Null),
        }))
        .collect();
    tag_dims.sort_by(|a, b| a["column"].as_str().unwrap_or("").cmp(b["column"].as_str().unwrap_or("")));

    let mut exclusion_rules: Vec<Value> = cs
        .rules
        .iter()
        .filter(|r| r.enabled)
        .map(|r| {
            let conditions: Vec<Value> = r.conditions.iter().map(|c| {
                let resolved = crate::query::resolve_field(&c.dimension_id, dims);
                let mut vals: Vec<String> = c.values.iter().map(|v| match &resolved {
                    Some(rf) => crate::query::normalize_rule_value_pub(v, rf),
                    None => v.clone(),
                }).collect();
                vals.sort();
                json!({ "dimensionId": c.dimension_id, "values": vals })
            }).collect();
            json!({ "conditions": conditions })
        })
        .collect();
    exclusion_rules.sort_by(|a, b| canonical_json(a).cmp(&canonical_json(b)));

    let mut obj = Map::new();
    obj.insert("schemaVersion".into(), json!(ROLLUP_SCHEMA_VERSION));
    obj.insert("builtinDims".into(), json!(builtin_dims));
    obj.insert("tagDims".into(), json!(tag_dims));
    obj.insert("costMetric".into(), json!(cs.cost_metric.clone().unwrap_or_else(|| "unblended".to_string())));
    obj.insert("costPerspective".into(), json!(cs.cost_perspective.clone().unwrap_or_else(|| "gross".to_string())));
    obj.insert("exclusionRules".into(), json!(exclusion_rules));
    let mkt = cs.active_marketplace_rules();
    if !mkt.is_empty() {
        let mut rules: Vec<Value> = mkt.iter().map(|r| {
            let mut ops = r.operations.clone();
            ops.sort();
            json!({ "service": r.service, "operations": ops })
        }).collect();
        rules.sort_by(|a, b| a["service"].as_str().unwrap_or("").cmp(b["service"].as_str().unwrap_or("")));
        obj.insert("marketplaceAttribution".into(), json!(rules));
    }
    obj.insert("orgAccountsDigest".into(), json!(org_digest));
    let mut cols = available_columns.to_vec();
    cols.sort();
    obj.insert("availableColumns".into(), json!(cols));
    sha256_hex(&canonical_json(&Value::Object(obj)))
}

/// usage_date + enabled built-in fields (+ displayField) + tag columns, sorted.
pub fn rollup_grain_columns(dims: &Dimensions) -> Vec<String> {
    let mut cols = BTreeSet::new();
    for d in &dims.built_in {
        if d.enabled == Some(false) {
            continue;
        }
        cols.insert(d.field.clone());
        if let Some(df) = &d.display_field {
            if !df.is_empty() {
                cols.insert(df.clone());
            }
        }
    }
    for t in &dims.tags {
        if t.enabled == Some(false) {
            continue;
        }
        cols.insert(crate::query::tag_dim_column(t));
    }
    cols.remove("usage_date");
    let mut rest: Vec<String> = cols.into_iter().collect();
    rest.sort();
    let mut out = vec!["usage_date".to_string()];
    out.append(&mut rest);
    out
}

pub struct Manifest {
    pub schema_version: i64,
    pub shape_signature: String,
    pub grain: BTreeSet<String>,
    pub available_columns: Vec<String>,
    pub partitions: BTreeSet<String>,
    pub etag_hashes: std::collections::BTreeMap<String, String>,
    pub rollup_rows: u64,
    pub rollup_bytes: u64,
}

fn manifest_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("aws").join("rollup").join("manifest.json")
}

pub fn load_manifest(data_dir: &str) -> Option<Manifest> {
    let raw = std::fs::read_to_string(manifest_path(data_dir)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let grain: BTreeSet<String> = v.get("grainDimensions")?.as_array()?.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
    let available_columns: Vec<String> = v.get("availableColumns").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let parts = v.get("partitions")?.as_object()?;
    let mut partitions = BTreeSet::new();
    let mut etag_hashes = std::collections::BTreeMap::new();
    let mut rollup_rows = 0u64;
    let mut rollup_bytes = 0u64;
    for (period, meta) in parts {
        partitions.insert(period.clone());
        if let Some(h) = meta.get("rawEtagHash").and_then(|x| x.as_str()) {
            etag_hashes.insert(period.clone(), h.to_string());
        }
        rollup_rows += meta.get("rows").and_then(|x| x.as_u64()).unwrap_or(0);
        rollup_bytes += meta.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0);
    }
    Some(Manifest {
        schema_version: v.get("schemaVersion").and_then(|x| x.as_i64()).unwrap_or(0),
        shape_signature: v.get("shapeSignature").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        grain,
        available_columns,
        partitions,
        etag_hashes,
        rollup_rows,
        rollup_bytes,
    })
}

/// Read the period→{fileKey:contentHash} map from sync-etags.json.
fn read_sync_etags(data_dir: &str) -> Value {
    std::fs::read_to_string(Path::new(data_dir).join("sync-etags.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// Freshness-validated routing: like `rollup_source` but ALSO rejects the rollup
/// when the shape signature no longer matches the live config or any required
/// period's raw-etag watermark is stale — so a config edit or a re-sync forces
/// raw (never silently-wrong numbers) until a rebuild.
pub fn rollup_source_validated(data_dir: &str, dims: &Dimensions, cs: &CostScope, tier: &str, periods: &[String], needed_fields: &[String]) -> Option<String> {
    if tier != "daily" || periods.is_empty() {
        return None;
    }
    let m = load_manifest(data_dir)?;
    if m.schema_version != ROLLUP_SCHEMA_VERSION {
        return None;
    }
    if !needed_fields.iter().all(|f| f == "cost" || f == "line_items" || m.grain.contains(f)) {
        return None;
    }
    // Config-shape freshness (reuse the manifest's availableColumns to avoid a
    // per-query parquet probe — they only change on a CUR-schema shift, which a
    // re-sync's etag change already catches below).
    let org_digest = org_accounts_digest(data_dir);
    if compute_shape_signature(dims, cs, &m.available_columns, &org_digest) != m.shape_signature {
        return None;
    }
    // Data freshness per period.
    let etags = read_sync_etags(data_dir);
    let empty = json!({});
    for p in periods {
        if !m.partitions.contains(p) {
            return None;
        }
        let want = partition_etag_hash(etags.get(p).unwrap_or(&empty));
        if m.etag_hashes.get(p).map(|s| s.as_str()) != Some(want.as_str()) {
            return None;
        }
    }
    let paths: Vec<String> = periods
        .iter()
        .map(|p| format!("'{}/aws/rollup/daily-{}/rollup.parquet'", sql_escape(data_dir), p))
        .collect();
    Some(format!("read_parquet([{}])", paths.join(", ")))
}

/// If every period is covered by a rollup partition and every needed raw field
/// is in-grain, return the rollup `read_parquet([...])` source. Else None (the
/// caller falls back to the raw, org-joined source). Daily tier only.
pub fn rollup_source(data_dir: &str, tier: &str, periods: &[String], needed_fields: &[String]) -> Option<String> {
    if tier != "daily" || periods.is_empty() {
        return None;
    }
    let m = load_manifest(data_dir)?;
    if !periods.iter().all(|p| m.partitions.contains(p)) {
        return None;
    }
    // "cost"/"line_items" are the baked aggregates; everything else must be in-grain.
    if !needed_fields.iter().all(|f| f == "cost" || f == "line_items" || m.grain.contains(f)) {
        return None;
    }
    let paths: Vec<String> = periods
        .iter()
        .map(|p| format!("'{}/aws/rollup/daily-{}/rollup.parquet'", sql_escape(data_dir), p))
        .collect();
    Some(format!("read_parquet([{}])", paths.join(", ")))
}

fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_bytes(&p);
            } else if let Ok(md) = std::fs::metadata(&p) {
                total += md.len();
            }
        }
    }
    total
}

/// RollupStatus discriminated union for the header indicator.
pub fn status(data_dir: &str) -> Value {
    match load_manifest(data_dir) {
        Some(m) if !m.partitions.is_empty() => json!({ "state": "ready", "periods": m.partitions.len() }),
        _ => json!({ "state": "idle" }),
    }
}

/// RollupStats for the popover (sizes are local reads — no AWS).
pub fn stats(data_dir: &str) -> Value {
    let Some(m) = load_manifest(data_dir) else { return Value::Null };
    let raw_bytes = dir_bytes(&Path::new(data_dir).join("aws").join("raw"));
    json!({
        "months": m.partitions.len(),
        "rollupRows": m.rollup_rows,
        "rollupBytes": m.rollup_bytes,
        "rawBytes": raw_bytes,
    })
}

fn size_band(bytes: u64) -> &'static str {
    match bytes {
        b if b < 16 * 1024 * 1024 => "tiny",
        b if b < 128 * 1024 * 1024 => "small",
        b if b < 512 * 1024 * 1024 => "moderate",
        b if b < 2 * 1024 * 1024 * 1024 => "large",
        _ => "huge",
    }
}

/// The grain columns a candidate DimensionsConfig would produce (enabled
/// built-in fields + displayField, enabled tag columns), used for the estimate.
fn candidate_grain(candidate: &Value) -> Vec<String> {
    let mut cols = vec![];
    if let Some(bi) = candidate.get("builtIn").and_then(|v| v.as_array()) {
        for b in bi {
            if b.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            if let Some(f) = b.get("field").and_then(|v| v.as_str()) {
                cols.push(f.to_string());
            }
            if let Some(df) = b.get("displayField").and_then(|v| v.as_str()) {
                cols.push(df.to_string());
            }
        }
    }
    if let Some(tags) = candidate.get("tags").and_then(|v| v.as_array()) {
        for t in tags {
            if t.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            if let Some(tn) = t.get("tagName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                cols.push(crate::query::sanitize_tag_col(tn));
            }
        }
    }
    cols
}

/// Best-effort RollupGrainEstimate for the grain-settings UI. Without an
/// expensive cardinality probe we base figures on the on-disk manifest + raw
/// size, and flag high-cardinality drivers (resource_id / usage_type) — enough
/// for the panel to render and warn. A production port would probe per-grain.
pub fn estimate_grain(data_dir: &str, candidate: &Value) -> Value {
    let manifest = load_manifest(data_dir);
    let months = manifest.as_ref().map(|m| m.partitions.len()).unwrap_or(0);
    let probe_period = manifest.as_ref().and_then(|m| m.partitions.iter().last().cloned()).unwrap_or_default();
    let raw_bytes = dir_bytes(&Path::new(data_dir).join("aws").join("raw"));
    let current = manifest.as_ref().map(|m| json!({ "rows": m.rollup_rows, "bytes": m.rollup_bytes }));
    let (cur_rows, cur_bytes) = manifest.as_ref().map(|m| (m.rollup_rows, m.rollup_bytes)).unwrap_or((0, 0));
    let per_partition = if months > 0 { cur_bytes / months as u64 } else { 0 };

    let grain = candidate_grain(candidate);
    let high_card: Vec<&str> = ["resource_id", "usage_type", "operation"].into_iter().filter(|c| grain.iter().any(|g| g == c)).collect();
    // Without a leave-one-out probe we can't compute true marginal impact, so the
    // per-dim figures are neutral (multiplier 1, no marginal rows). The amber
    // high-cardinality flag is the actionable signal the panel still surfaces.
    let dims: Vec<Value> = grain.iter().map(|c| {
        let flagged = high_card.contains(&c.as_str());
        json!({ "column": c, "cardinality": 0, "rawOnly": flagged, "marginalMultiplier": 1.0, "marginalRows": 0, "impactShare": 0.0, "outlier": flagged })
    }).collect();
    let raw_only_reason = if high_card.is_empty() {
        Value::Null
    } else {
        json!(format!("grain includes high-cardinality {} — barely compresses vs raw; consider dropping it or using raw-only", high_card.join(", ")))
    };

    json!({
        "probePeriod": probe_period,
        "months": months,
        "lineItems": 0,
        "raw": { "rows": 0, "bytes": raw_bytes },
        "current": current,
        "currentMatchesCandidate": true,
        "candidate": {
            "rows": cur_rows,
            "bytes": cur_bytes,
            "perPartitionBytes": per_partition,
            "sizeBand": size_band(cur_bytes),
            "rebuildSeconds": 0,
            "rebuildBand": "instant",
            "growthFactor": if cur_rows > 0 { json!(1.0) } else { Value::Null },
        },
        "compressionRate": 1,
        "rawOnly": { "recommended": !high_card.is_empty(), "reason": raw_only_reason },
        "dims": dims,
    })
}

// --- build (COPY per period → manifest) ---

fn period_upper_bound(period: &str) -> String {
    let y: i64 = period.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(1970);
    let m: i64 = period.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1);
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    format!("{ny:04}-{nm:02}-01")
}

/// Probe the latest month's parquet for the CUR columns present (feeds the
/// signature; mirrors core's availableColumns probe, schema-drift tolerant).
fn available_columns(data_dir: &str, months: &[String]) -> Vec<String> {
    let Some(latest) = months.last() else { return vec![] };
    let glob = format!("{}/aws/raw/daily-{}/*.parquet", sql_escape(data_dir), latest);
    let sql = format!("SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet('{glob}', union_by_name=true))");
    let conn = match crate::db::open() {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    crate::db::query_map(&conn, &sql, &[], |r| crate::db::str_at(r, 0)).unwrap_or_default()
}

/// Build (or refresh) the per-period rollup partitions for every local daily
/// month and write the manifest atomically. Skips periods already current under
/// the live shape signature + raw-etag watermark unless `force`. Returns a
/// RollupStatus-shaped value.
pub fn build_rollup(data_dir: &str, config_dir: &Path, force: bool) -> Result<Value, String> {
    let dims = crate::config::load_dimensions(config_dir)?;
    let cs = crate::config::load_cost_scope(config_dir);
    let metric = crate::config::normalize_metric(&cs.cost_metric);
    let net = cs.cost_perspective.as_deref() == Some("net");
    let org_path = crate::config::org_tags_path(Path::new(data_dir));
    let exclusions = crate::query::build_exclusion_clauses(&cs, &dims);
    let marketplace = cs.active_marketplace_rules();

    let months = crate::query::list_local_months(data_dir, "daily");
    if months.is_empty() {
        return Ok(json!({ "state": "idle" }));
    }
    let mut avail = available_columns(data_dir, &months);
    avail.sort();
    let org_digest = org_accounts_digest(data_dir);
    let signature = compute_shape_signature(&dims, &cs, &avail, &org_digest);
    let grain = rollup_grain_columns(&dims);
    let grain_join = grain.join(", ");
    let etags = read_sync_etags(data_dir);
    let empty = json!({});

    // Carry over still-valid partitions when the signature is unchanged.
    let prev = load_manifest(data_dir);
    let prev_raw: Value = std::fs::read_to_string(manifest_path(data_dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
    let mut partitions = Map::new();
    let sig_unchanged = prev.as_ref().map(|m| m.shape_signature == signature).unwrap_or(false);

    let dir = Path::new(data_dir).join("aws").join("rollup");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir rollup: {e}"))?;
    let conn = crate::db::open()?;
    let mut built = 0u64;

    for period in &months {
        let want = partition_etag_hash(etags.get(period).unwrap_or(&empty));
        // Skip rebuild when the signature + this period's watermark are unchanged
        // AND the partition file is still on disk — carry its meta forward.
        let prev_meta = prev_raw.get("partitions").and_then(|p| p.get(period));
        let part_path = dir.join(format!("daily-{period}")).join("rollup.parquet");
        if !force && sig_unchanged && prev.as_ref().and_then(|m| m.etag_hashes.get(period)) == Some(&want) && part_path.exists() {
            if let Some(meta) = prev_meta {
                partitions.insert(period.clone(), meta.clone());
                continue;
            }
        }
        let part_dir = dir.join(format!("daily-{period}"));
        std::fs::create_dir_all(&part_dir).map_err(|e| format!("mkdir {period}: {e}"))?;
        let out = part_dir.join("rollup.parquet");
        let out_s = out.to_string_lossy().replace('\'', "''");
        // Probe THIS month's columns so the source references only what exists
        // (older CUR months lack reservation/savings-plan cost columns).
        let pcols = available_columns(data_dir, std::slice::from_ref(period));
        let source = crate::query::build_source(data_dir, "daily", std::slice::from_ref(period), &metric, net, &dims, org_path.as_deref(), &marketplace, &pcols);
        let start = format!("{period}-01");
        let end = period_upper_bound(period);
        let mut wheres = vec![format!("usage_date >= '{start}'"), format!("usage_date < '{end}'")];
        wheres.extend(exclusions.iter().cloned());
        let select = format!(
            "SELECT {grain_join}, CAST(SUM(cost) AS DOUBLE) AS cost, CAST(COUNT(*) AS BIGINT) AS line_items FROM {source} WHERE {} GROUP BY {grain_join}",
            wheres.join(" AND ")
        );
        let copy = format!("COPY ({select}) TO '{out_s}' (FORMAT PARQUET)");
        conn.execute(&copy, []).map_err(|e| format!("rollup build {period}: {e}"))?;
        let rows = crate::db::query_map(&conn, &format!("SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM read_parquet('{out_s}')"), &[], |r| crate::db::f64_at(r, 0))
            .ok()
            .and_then(|v| v.first().copied())
            .unwrap_or(0.0) as u64;
        let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        partitions.insert(period.clone(), json!({ "rawEtagHash": want, "rows": rows, "bytes": bytes }));
        built += 1;
    }

    let manifest = json!({
        "schemaVersion": ROLLUP_SCHEMA_VERSION,
        "shapeSignature": signature,
        "builtAt": "",
        "grainDimensions": grain,
        "availableColumns": avail,
        "partitions": Value::Object(partitions),
    });
    let tmp = dir.join("manifest.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| format!("write manifest tmp: {e}"))?;
    std::fs::rename(&tmp, dir.join("manifest.json")).map_err(|e| format!("rename manifest: {e}"))?;
    Ok(json!({ "state": "ready", "periods": months.len(), "built": built }))
}
