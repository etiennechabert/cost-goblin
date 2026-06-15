//! Config-bundle assembly, fingerprinting, parse + summarize — ported from
//! `@costgoblin/core` `config/sharing-bundle.ts`.
//!
//! Fidelity note on the fingerprint: Electron computes
//! `SHA-256(JSON.stringify(sectionsToYamlObjects(sections)))`. We build the
//! sections in the *same* YAML-object shape (reusing the `*_to_yaml`
//! transformers) and hash the compact JSON of that object. `serde_json` with
//! `preserve_order` emits compact, insertion-ordered JSON that matches JS
//! `JSON.stringify`, so a Tauri-exported bundle re-imports as
//! `fingerprintValid: true` — and an Electron-exported one validates too for
//! typical configs.

use crate::config_write::{cost_scope_to_yaml, dimensions_config_to_yaml, views_config_to_yaml};
use serde_json::{json, Map, Value as J};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const CONFIG_BUNDLE_KIND: &str = "costgoblin-config-bundle";
pub const CONFIG_BUNDLE_SCHEMA_VERSION: i64 = 1;
pub const CONFIG_BEACON_KEY: &str = "costgoblin/org-config.yaml";

const BUNDLE_HEADER: &str = "# CostGoblin configuration bundle\n# Share this file with teammates: they import it from the setup wizard or\n# the options menu. It contains NO credentials — receivers pick their own\n# AWS profile on import.\n";

// --- YAML-object transformers (stable key order) ---

fn sync_to_yaml(sync: &J) -> J {
    let bucket_obj = |o: &J| -> J {
        json!({
            "bucket": o.get("bucket").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "retentionDays": o.get("retentionDays").cloned().unwrap_or(J::Null),
        })
    };
    let mut o = Map::new();
    if let Some(daily) = sync.get("daily") {
        o.insert("daily".into(), bucket_obj(daily));
    }
    if let Some(hourly) = sync.get("hourly") {
        o.insert("hourly".into(), bucket_obj(hourly));
    }
    if let Some(co) = sync.get("costOptimization") {
        o.insert("costOptimization".into(), bucket_obj(co));
    }
    o.insert("intervalMinutes".into(), sync.get("intervalMinutes").cloned().unwrap_or(J::Null));
    J::Object(o)
}

/// Shared config (credentials dropped) → YAML object.
fn shared_config_to_yaml(config: &J) -> J {
    let providers: Vec<J> = config.get("providers").and_then(|v| v.as_array()).map(|a| a.iter().map(|p| {
        json!({
            "name": p.get("name").cloned().unwrap_or(J::Null),
            "type": p.get("type").cloned().unwrap_or(J::Null),
            "sync": sync_to_yaml(p.get("sync").unwrap_or(&J::Null)),
        })
    }).collect()).unwrap_or_default();
    let defaults = config.get("defaults").cloned().unwrap_or_else(|| json!({}));
    json!({
        "providers": providers,
        "defaults": {
            "periodDays": defaults.get("periodDays").cloned().unwrap_or(J::Null),
            "costMetric": defaults.get("costMetric").cloned().unwrap_or(J::Null),
            "lagDays": defaults.get("lagDays").cloned().unwrap_or(J::Null),
        },
    })
}

fn org_node_to_yaml(node: &J) -> J {
    let mut o = Map::new();
    o.insert("name".into(), node.get("name").cloned().unwrap_or(J::Null));
    if node.get("virtual").and_then(|v| v.as_bool()) == Some(true) {
        o.insert("virtual".into(), json!(true));
    }
    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        o.insert("children".into(), json!(children.iter().map(org_node_to_yaml).collect::<Vec<_>>()));
    }
    J::Object(o)
}

fn org_tree_to_yaml(cfg: &J) -> J {
    let tree: Vec<J> = cfg.get("tree").and_then(|v| v.as_array()).map(|a| a.iter().map(org_node_to_yaml).collect()).unwrap_or_default();
    json!({ "tree": tree })
}

/// Build the `sections` YAML object (the hashed canonical form) from the raw,
/// on-disk config Values. `config_raw` is costgoblin.yaml's content.
fn sections_to_yaml_objects(config_raw: &J, dimensions: &J, org_tree: Option<&J>, cost_scope: Option<&J>, views: Option<&J>) -> J {
    let mut o = Map::new();
    o.insert("config".into(), shared_config_to_yaml(config_raw));
    o.insert("dimensions".into(), dimensions_config_to_yaml(dimensions));
    if let Some(ot) = org_tree {
        o.insert("orgTree".into(), org_tree_to_yaml(ot));
    }
    if let Some(cs) = cost_scope {
        o.insert("costScope".into(), cost_scope_to_yaml(cs));
    }
    if let Some(v) = views {
        o.insert("views".into(), views_config_to_yaml(v));
    }
    J::Object(o)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn compute_fingerprint(sections_obj: &J) -> String {
    let json = serde_json::to_string(sections_obj).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(json.as_bytes());
    hex(&h.finalize())
}

// --- build + serialize (export) ---

/// Assemble the bundle YAML string from the on-disk config dir. `org-tree.yaml`
/// / `cost-scope.yaml` / `views.yaml` are included only when present & non-empty.
pub fn build_bundle_yaml(config_dir: &Path, app_version: &str, exported_at: &str) -> Result<String, String> {
    let load = |name: &str| crate::config::load_yaml_json(&config_dir.join(name)).ok();
    let config_raw = load("costgoblin.yaml").ok_or("costgoblin.yaml not found")?;
    let dimensions = load("dimensions.yaml").ok_or("dimensions.yaml not found")?;
    let org_tree = load("org-tree.yaml").filter(|v| v.get("tree").and_then(|t| t.as_array()).map(|a| !a.is_empty()).unwrap_or(false));
    let cost_scope = load("cost-scope.yaml");
    let views = load("views.yaml").filter(|v| v.get("views").and_then(|t| t.as_array()).map(|a| !a.is_empty()).unwrap_or(false));

    let sections = sections_to_yaml_objects(&config_raw, &dimensions, org_tree.as_ref(), cost_scope.as_ref(), views.as_ref());
    let fingerprint = compute_fingerprint(&sections);
    let top = json!({
        "kind": CONFIG_BUNDLE_KIND,
        "schemaVersion": CONFIG_BUNDLE_SCHEMA_VERSION,
        "appVersion": app_version,
        "exportedAt": exported_at,
        "fingerprint": fingerprint,
        "sections": sections,
    });
    let yaml = serde_yaml::to_string(&top).map_err(|e| format!("serialize bundle: {e}"))?;
    Ok(format!("{BUNDLE_HEADER}{yaml}"))
}

// --- parse + summarize (import) ---

pub struct ParsedBundle {
    pub sections: J,
    pub schema_version: i64,
    pub app_version: String,
    pub exported_at: String,
    pub fingerprint: String,
    pub fingerprint_valid: bool,
}

/// Parse + structurally validate a bundle. Untrusted input — reject non-bundles
/// and newer schema versions with a clear message.
pub fn parse_bundle(content: &str) -> Result<ParsedBundle, String> {
    let raw: J = serde_yaml::from_str(content).map_err(|e| format!("Not valid YAML: {e}"))?;
    if raw.get("kind").and_then(|v| v.as_str()) != Some(CONFIG_BUNDLE_KIND) {
        return Err("Not a CostGoblin configuration bundle (missing or wrong \"kind\" field)".to_string());
    }
    let schema_version = raw.get("schemaVersion").and_then(|v| v.as_i64()).ok_or("schemaVersion must be a number")?;
    if schema_version > CONFIG_BUNDLE_SCHEMA_VERSION {
        return Err(format!("Bundle schema version {schema_version} is newer than this app supports ({CONFIG_BUNDLE_SCHEMA_VERSION}). Update CostGoblin and retry."));
    }
    if schema_version < 1 {
        return Err("schemaVersion must be >= 1".to_string());
    }
    let sections = raw.get("sections").cloned().ok_or("sections missing")?;
    if !sections.is_object() {
        return Err("sections must be an object".to_string());
    }
    if sections.get("config").and_then(|c| c.get("providers")).and_then(|p| p.as_array()).is_none() {
        return Err("sections.config.providers must be an array".to_string());
    }
    if !sections.get("dimensions").map(|d| d.is_object()).unwrap_or(false) {
        return Err("sections.dimensions must be an object".to_string());
    }
    let fingerprint = raw.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Re-hash the stored sections (already in canonical YAML-object form).
    let fingerprint_valid = compute_fingerprint(&sections) == fingerprint;
    Ok(ParsedBundle {
        sections,
        schema_version,
        app_version: raw.get("appVersion").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        exported_at: raw.get("exportedAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        fingerprint,
        fingerprint_valid,
    })
}

fn count_org_nodes(nodes: &[J]) -> usize {
    nodes.iter().map(|n| 1 + n.get("children").and_then(|c| c.as_array()).map(|a| count_org_nodes(a)).unwrap_or(0)).sum()
}

pub fn section_ids(sections: &J) -> Vec<&'static str> {
    let mut ids = vec!["config", "dimensions"];
    if sections.get("orgTree").is_some() {
        ids.push("orgTree");
    }
    if sections.get("costScope").is_some() {
        ids.push("costScope");
    }
    if sections.get("views").is_some() {
        ids.push("views");
    }
    ids
}

pub fn summarize(p: &ParsedBundle) -> J {
    let s = &p.sections;
    let providers: Vec<J> = s.get("config").and_then(|c| c.get("providers")).and_then(|v| v.as_array()).map(|a| a.iter().map(|prov| {
        json!({
            "name": prov.get("name").cloned().unwrap_or(J::Null),
            "dailyBucket": prov.get("sync").and_then(|sy| sy.get("daily")).and_then(|d| d.get("bucket")).and_then(|b| b.as_str()).unwrap_or("").to_string(),
        })
    }).collect()).unwrap_or_default();
    let built_in = s.get("dimensions").and_then(|d| d.get("builtIn")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let tags = s.get("dimensions").and_then(|d| d.get("tags")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let org_nodes = s.get("orgTree").and_then(|o| o.get("tree")).and_then(|v| v.as_array()).map(|a| count_org_nodes(a)).unwrap_or(0);
    let rules = s.get("costScope").and_then(|c| c.get("rules")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let view_count = s.get("views").and_then(|v| v.get("views")).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
    json!({
        "schemaVersion": p.schema_version,
        "appVersion": p.app_version,
        "exportedAt": p.exported_at,
        "fingerprint": p.fingerprint,
        "fingerprintValid": p.fingerprint_valid,
        "sections": section_ids(s),
        "providers": providers,
        "builtInDimensionCount": built_in,
        "tagDimensionCount": tags,
        "orgTreeNodeCount": org_nodes,
        "exclusionRuleCount": rules,
        "viewCount": view_count,
    })
}

/// Materialize a parsed bundle's sections onto disk, injecting `profile` into
/// every provider's credentials. Returns the written section ids. Backs up
/// first (see sharing::backup_config).
pub fn materialize(config_dir: &Path, sections: &J, profile: &str) -> Result<Vec<&'static str>, String> {
    let write = |name: &str, value: &J| -> Result<(), String> {
        let path = config_dir.join(name);
        let yaml = serde_yaml::to_string(value).map_err(|e| format!("serialize {name}: {e}"))?;
        std::fs::write(&path, yaml).map_err(|e| format!("write {}: {e}", path.display()))
    };
    // costgoblin.yaml — re-attach credentials.profile (stored sync shape is reused as-is).
    let shared = sections.get("config").cloned().unwrap_or_else(|| json!({}));
    let providers: Vec<J> = shared.get("providers").and_then(|v| v.as_array()).map(|a| a.iter().map(|p| {
        json!({
            "name": p.get("name").cloned().unwrap_or(J::Null),
            "type": p.get("type").cloned().unwrap_or(J::Null),
            "credentials": { "profile": profile },
            "sync": p.get("sync").cloned().unwrap_or(J::Null),
        })
    }).collect()).unwrap_or_default();
    let cgyaml = json!({ "providers": providers, "defaults": shared.get("defaults").cloned().unwrap_or_else(|| json!({})) });
    write("costgoblin.yaml", &cgyaml)?;

    if let Some(d) = sections.get("dimensions") {
        write("dimensions.yaml", d)?;
    }
    if let Some(o) = sections.get("orgTree") {
        write("org-tree.yaml", o)?;
    }
    if let Some(c) = sections.get("costScope") {
        write("cost-scope.yaml", c)?;
    }
    if let Some(v) = sections.get("views") {
        write("views.yaml", v)?;
    }
    Ok(section_ids(sections))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_fingerprint_valid() {
        // Build sections, serialize as a bundle Value, re-parse → fingerprint must match.
        let config_raw = json!({ "providers": [{ "name": "AWS", "type": "aws", "credentials": { "profile": "secret" }, "sync": { "daily": { "bucket": "b", "retentionDays": 90 }, "intervalMinutes": 60 } }], "defaults": { "periodDays": 30, "costMetric": "list", "lagDays": 2 } });
        let dimensions = json!({ "builtIn": [{ "name": "Service", "label": "Service", "field": "service" }], "tags": [{ "tagName": "user_team", "label": "Team" }] });
        let sections = sections_to_yaml_objects(&config_raw, &dimensions, None, None, None);
        // credentials must NOT survive into the bundle
        assert!(sections["config"]["providers"][0].get("credentials").is_none());
        let fp = compute_fingerprint(&sections);
        let top = json!({ "kind": CONFIG_BUNDLE_KIND, "schemaVersion": 1, "appVersion": "x", "exportedAt": "t", "fingerprint": fp, "sections": sections });
        let yaml = serde_yaml::to_string(&top).unwrap();
        let parsed = parse_bundle(&yaml).expect("parse");
        assert!(parsed.fingerprint_valid, "round-tripped bundle should validate");
        let sum = summarize(&parsed);
        assert_eq!(sum["builtInDimensionCount"], json!(1));
        assert_eq!(sum["tagDimensionCount"], json!(1));
        assert_eq!(sum["providers"][0]["dailyBucket"], json!("b"));
    }

    #[test]
    fn rejects_non_bundle_and_edited() {
        assert!(parse_bundle("foo: bar").is_err());
        let config_raw = json!({ "providers": [{ "name": "AWS", "type": "aws", "sync": { "daily": { "bucket": "b", "retentionDays": 90 }, "intervalMinutes": 60 } }], "defaults": { "periodDays": 30, "costMetric": "list", "lagDays": 2 } });
        let dimensions = json!({ "builtIn": [], "tags": [] });
        let sections = sections_to_yaml_objects(&config_raw, &dimensions, None, None, None);
        let top = json!({ "kind": CONFIG_BUNDLE_KIND, "schemaVersion": 1, "appVersion": "x", "exportedAt": "t", "fingerprint": "deadbeef", "sections": sections });
        let parsed = parse_bundle(&serde_yaml::to_string(&top).unwrap()).unwrap();
        assert!(!parsed.fingerprint_valid, "wrong fingerprint flagged");
    }
}
