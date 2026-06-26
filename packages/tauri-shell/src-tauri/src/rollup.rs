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

use crate::query::sql_escape;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub struct Manifest {
    pub grain: BTreeSet<String>,
    pub partitions: BTreeSet<String>,
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
    let parts = v.get("partitions")?.as_object()?;
    let mut partitions = BTreeSet::new();
    let mut rollup_rows = 0u64;
    let mut rollup_bytes = 0u64;
    for (period, meta) in parts {
        partitions.insert(period.clone());
        rollup_rows += meta.get("rows").and_then(|x| x.as_u64()).unwrap_or(0);
        rollup_bytes += meta.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0);
    }
    Some(Manifest { grain, partitions, rollup_rows, rollup_bytes })
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
    let dims: Vec<Value> = grain.iter().map(|c| json!({ "column": c, "cardinality": 0, "rawOnly": high_card.contains(&c.as_str()) })).collect();
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
