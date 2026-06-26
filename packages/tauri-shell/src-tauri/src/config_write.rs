//! YAML config writes — the mutating half of the config surface.
//!
//! The renderer hands us the *internal* config objects (`DimensionsConfig`,
//! `ViewsConfig`, `CostScopeConfig`) as JSON. Electron reshapes those into a
//! stable, undefined-omitting YAML form via the `*ConfigToYaml` transformers in
//! `@costgoblin/core` before `yaml.stringify`. We replicate those transformers
//! here on `serde_json::Value` so the files we write round-trip identically
//! (and so the fingerprint in `sharing.rs` matches the TS one byte-for-byte —
//! `serde_json`'s `preserve_order` keeps insertion order).

use serde_json::{json, Map, Value as J};
use std::path::Path;

const DEFAULT_LAG_DAYS: i64 = 2;

// --- small helpers mirroring the TS `x === undefined ? {} : { x }` idiom ---

/// Present (non-null) value for `key`, else None — JS `undefined` fields are
/// simply absent in the JSON the renderer sends.
fn get<'a>(o: &'a J, key: &str) -> Option<&'a J> {
    match o.get(key) {
        None | Some(J::Null) => None,
        Some(v) => Some(v),
    }
}
fn is_true(o: &J, key: &str) -> bool {
    o.get(key).and_then(|v| v.as_bool()) == Some(true)
}
fn is_false(o: &J, key: &str) -> bool {
    o.get(key).and_then(|v| v.as_bool()) == Some(false)
}
fn nonempty_arr<'a>(o: &'a J, key: &str) -> Option<&'a J> {
    match o.get(key) {
        Some(J::Array(a)) if !a.is_empty() => o.get(key),
        _ => None,
    }
}
fn nonempty_str<'a>(o: &'a J, key: &str) -> Option<&'a J> {
    match o.get(key) {
        Some(J::String(s)) if !s.is_empty() => o.get(key),
        _ => None,
    }
}

// --- dimensions (mirror dimensions-serialize.ts) ---

fn built_in_to_yaml(d: &J) -> J {
    let mut o = Map::new();
    o.insert("name".into(), d.get("name").cloned().unwrap_or(J::Null));
    o.insert("label".into(), d.get("label").cloned().unwrap_or(J::Null));
    o.insert("field".into(), d.get("field").cloned().unwrap_or(J::Null));
    if let Some(v) = get(d, "displayField") { o.insert("displayField".into(), v.clone()); }
    if let Some(v) = get(d, "description") { o.insert("description".into(), v.clone()); }
    if let Some(v) = get(d, "normalize") { o.insert("normalize".into(), v.clone()); }
    if let Some(v) = get(d, "aliases") { o.insert("aliases".into(), v.clone()); }
    if is_true(d, "useOrgAccounts") { o.insert("useOrgAccounts".into(), json!(true)); }
    if let Some(v) = nonempty_str(d, "accountNameFromTag") { o.insert("accountNameFromTag".into(), v.clone()); }
    if let Some(v) = nonempty_arr(d, "nameStripPatterns") { o.insert("nameStripPatterns".into(), v.clone()); }
    if let Some(v) = get(d, "useRegionNames") { o.insert("useRegionNames".into(), v.clone()); }
    if is_false(d, "enabled") { o.insert("enabled".into(), json!(false)); }
    if let Some(v) = nonempty_arr(d, "defaultFilterValues") { o.insert("defaultFilterValues".into(), v.clone()); }
    J::Object(o)
}

fn tag_to_yaml(t: &J) -> J {
    let mut o = Map::new();
    if let Some(v) = nonempty_str(t, "tagName") { o.insert("tagName".into(), v.clone()); }
    o.insert("label".into(), t.get("label").cloned().unwrap_or(J::Null));
    if let Some(v) = get(t, "concept") { o.insert("concept".into(), v.clone()); }
    if let Some(v) = get(t, "normalize") { o.insert("normalize".into(), v.clone()); }
    if let Some(v) = get(t, "separator") { o.insert("separator".into(), v.clone()); }
    if let Some(v) = get(t, "aliases") { o.insert("aliases".into(), v.clone()); }
    if let Some(v) = get(t, "accountTagFallback") { o.insert("accountTagFallback".into(), v.clone()); }
    if let Some(v) = get(t, "missingValueTemplate") { o.insert("missingValueTemplate".into(), v.clone()); }
    if let Some(ps) = get(t, "pathSegment") {
        o.insert("pathSegment".into(), json!({ "separator": ps.get("separator").cloned().unwrap_or(J::Null), "index": ps.get("index").cloned().unwrap_or(J::Null) }));
    }
    if let Some(v) = get(t, "description") { o.insert("description".into(), v.clone()); }
    if is_false(t, "enabled") { o.insert("enabled".into(), json!(false)); }
    if let Some(v) = nonempty_arr(t, "defaultFilterValues") { o.insert("defaultFilterValues".into(), v.clone()); }
    J::Object(o)
}

pub fn dimensions_config_to_yaml(config: &J) -> J {
    let built_in: Vec<J> = config.get("builtIn").and_then(|v| v.as_array()).map(|a| a.iter().map(built_in_to_yaml).collect()).unwrap_or_default();
    let tags: Vec<J> = config.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().map(tag_to_yaml).collect()).unwrap_or_default();
    let mut o = Map::new();
    o.insert("builtIn".into(), json!(built_in));
    o.insert("tags".into(), json!(tags));
    if let Some(v) = nonempty_arr(config, "order") { o.insert("order".into(), v.clone()); }
    J::Object(o)
}

// --- views (mirror views-serialize.ts) ---

fn widget_to_yaml(w: &J) -> J {
    let mut o = Map::new();
    o.insert("id".into(), w.get("id").cloned().unwrap_or(J::Null));
    o.insert("type".into(), w.get("type").cloned().unwrap_or(J::Null));
    o.insert("size".into(), w.get("size").cloned().unwrap_or(J::Null));
    if let Some(v) = get(w, "title") { o.insert("title".into(), v.clone()); }
    let ty = w.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let add_group_by = |o: &mut Map<String, J>| {
        o.insert("groupBy".into(), w.get("groupBy").cloned().unwrap_or(J::Null));
    };
    match ty {
        "summary" => {
            if let Some(v) = get(w, "metric") { o.insert("metric".into(), v.clone()); }
        }
        "pie" | "stackedBar" => add_group_by(&mut o),
        "bubble" => {
            add_group_by(&mut o);
            if let Some(v) = get(w, "logScale") { o.insert("logScale".into(), v.clone()); }
            if let Some(v) = get(w, "deltaThreshold") { o.insert("deltaThreshold".into(), v.clone()); }
            if let Some(v) = get(w, "percentThreshold") { o.insert("percentThreshold".into(), v.clone()); }
        }
        "treemap" => {
            add_group_by(&mut o);
            if let Some(v) = get(w, "drillTo") { o.insert("drillTo".into(), v.clone()); }
        }
        "line" | "topNBar" | "heatmap" => {
            add_group_by(&mut o);
            if let Some(v) = get(w, "topN") { o.insert("topN".into(), v.clone()); }
        }
        "table" => {
            if let Some(v) = nonempty_arr(w, "enabledColumns") { o.insert("enabledColumns".into(), v.clone()); }
        }
        _ => {}
    }
    J::Object(o)
}

fn view_to_yaml(v: &J) -> J {
    let mut o = Map::new();
    o.insert("id".into(), v.get("id").cloned().unwrap_or(J::Null));
    o.insert("name".into(), v.get("name").cloned().unwrap_or(J::Null));
    if let Some(x) = get(v, "icon") { o.insert("icon".into(), x.clone()); }
    if is_true(v, "builtIn") { o.insert("builtIn".into(), json!(true)); }
    let rows: Vec<J> = v.get("rows").and_then(|r| r.as_array()).map(|a| a.iter().map(|row| {
        let widgets: Vec<J> = row.get("widgets").and_then(|w| w.as_array()).map(|ws| ws.iter().map(widget_to_yaml).collect()).unwrap_or_default();
        json!({ "widgets": widgets })
    }).collect()).unwrap_or_default();
    o.insert("rows".into(), json!(rows));
    J::Object(o)
}

pub fn views_config_to_yaml(cfg: &J) -> J {
    let views: Vec<J> = cfg.get("views").and_then(|v| v.as_array()).map(|a| a.iter().map(view_to_yaml).collect()).unwrap_or_default();
    json!({ "views": views })
}

// --- cost-scope (mirror cost-scope-serialize.ts) ---

fn rule_to_yaml(r: &J) -> J {
    let mut o = Map::new();
    o.insert("id".into(), r.get("id").cloned().unwrap_or(J::Null));
    o.insert("name".into(), r.get("name").cloned().unwrap_or(J::Null));
    if let Some(v) = get(r, "description") { o.insert("description".into(), v.clone()); }
    o.insert("enabled".into(), r.get("enabled").cloned().unwrap_or(json!(false)));
    o.insert("builtIn".into(), r.get("builtIn").cloned().unwrap_or(json!(false)));
    let conditions: Vec<J> = r.get("conditions").and_then(|c| c.as_array()).map(|a| a.iter().map(|c| {
        json!({
            "dimensionId": c.get("dimensionId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "values": c.get("values").cloned().unwrap_or(json!([])),
        })
    }).collect()).unwrap_or_default();
    o.insert("conditions".into(), json!(conditions));
    J::Object(o)
}

pub fn cost_scope_to_yaml(cfg: &J) -> J {
    let mut o = Map::new();
    o.insert("costMetric".into(), cfg.get("costMetric").cloned().unwrap_or(J::Null));
    match cfg.get("costPerspective").and_then(|v| v.as_str()) {
        Some(p) if p != "gross" => { o.insert("costPerspective".into(), json!(p)); }
        _ => {}
    }
    let lag = cfg.get("lagDays").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_LAG_DAYS);
    if lag != DEFAULT_LAG_DAYS {
        o.insert("lagDays".into(), json!(lag));
    }
    let rules: Vec<J> = cfg.get("rules").and_then(|r| r.as_array()).map(|a| a.iter().map(rule_to_yaml).collect()).unwrap_or_default();
    o.insert("rules".into(), json!(rules));
    if let Some(m) = get(cfg, "marketplaceAttribution") {
        let mrules: Vec<J> = m.get("rules").and_then(|r| r.as_array()).map(|a| a.iter().map(|r| json!({
            "service": r.get("service").cloned().unwrap_or(J::Null),
            "operations": r.get("operations").cloned().unwrap_or(json!([])),
        })).collect()).unwrap_or_default();
        o.insert("marketplaceAttribution".into(), json!({ "enabled": m.get("enabled").cloned().unwrap_or(json!(false)), "rules": mrules }));
    }
    J::Object(o)
}

// --- file writes ---

fn write_yaml(path: &Path, value: &J) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let yaml = serde_yaml::to_string(value).map_err(|e| format!("serialize {}: {e}", path.display()))?;
    std::fs::write(path, yaml).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn save_dimensions(config_dir: &Path, config: &J) -> Result<(), String> {
    write_yaml(&config_dir.join("dimensions.yaml"), &dimensions_config_to_yaml(config))
}
pub fn save_views(config_dir: &Path, config: &J) -> Result<(), String> {
    write_yaml(&config_dir.join("views.yaml"), &views_config_to_yaml(config))
}
pub fn save_cost_scope(config_dir: &Path, config: &J) -> Result<(), String> {
    write_yaml(&config_dir.join("cost-scope.yaml"), &cost_scope_to_yaml(config))
}

/// Surgical profile swap: rewrite ONLY `providers[0].credentials.profile`,
/// preserving every other field (mirrors the desktop `config:update-aws-profile`).
pub fn update_aws_profile(config_dir: &Path, profile: &str) -> Result<(), String> {
    let path = config_dir.join("costgoblin.yaml");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut parsed: J = serde_yaml::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let providers = parsed
        .get_mut("providers")
        .and_then(|v| v.as_array_mut())
        .ok_or("No providers configured")?;
    let first = providers.first_mut().ok_or("No providers configured")?;
    let obj = first.as_object_mut().ok_or("First provider entry is not an object")?;
    let creds = obj.entry("credentials").or_insert_with(|| json!({}));
    if let Some(c) = creds.as_object_mut() {
        c.insert("profile".into(), json!(profile));
    }
    write_yaml(&path, &parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dimensions_yaml_omits_undefined_and_keeps_order() {
        let cfg = json!({
            "builtIn": [{ "name": "Service", "label": "Service", "field": "service", "enabled": false, "useOrgAccounts": true, "nameStripPatterns": [] }],
            "tags": [{ "tagName": "user_team", "label": "Team", "concept": "owner", "pathSegment": { "separator": "/", "index": 1 } }],
        });
        let y = dimensions_config_to_yaml(&cfg);
        let b = &y["builtIn"][0];
        // enabled:false is kept, useOrgAccounts:true kept, empty nameStripPatterns dropped
        assert_eq!(b["enabled"], json!(false));
        assert_eq!(b["useOrgAccounts"], json!(true));
        assert!(b.get("nameStripPatterns").is_none());
        assert!(b.get("description").is_none());
        // first three keys in stable order
        let keys: Vec<&String> = b.as_object().unwrap().keys().collect();
        assert_eq!(keys[0], "name");
        assert_eq!(keys[1], "label");
        assert_eq!(keys[2], "field");
        let t = &y["tags"][0];
        assert_eq!(t["pathSegment"]["index"], json!(1));
    }

    #[test]
    fn cost_scope_yaml_drops_defaults() {
        let cfg = json!({ "costMetric": "UnblendedCost", "costPerspective": "gross", "lagDays": 2, "rules": [] });
        let y = cost_scope_to_yaml(&cfg);
        assert_eq!(y["costMetric"], json!("UnblendedCost"));
        assert!(y.get("costPerspective").is_none(), "gross perspective is the default → dropped");
        assert!(y.get("lagDays").is_none(), "default lagDays dropped");
        let cfg2 = json!({ "costMetric": "list", "costPerspective": "net", "lagDays": 5, "rules": [{ "id": "r1", "name": "n", "enabled": true, "builtIn": false, "conditions": [{ "dimensionId": "service", "values": ["x"] }] }] });
        let y2 = cost_scope_to_yaml(&cfg2);
        assert_eq!(y2["costPerspective"], json!("net"));
        assert_eq!(y2["lagDays"], json!(5));
        assert_eq!(y2["rules"][0]["conditions"][0]["dimensionId"], json!("service"));
    }

    #[test]
    fn views_yaml_per_widget_type() {
        let cfg = json!({ "views": [{ "id": "v1", "name": "V", "rows": [{ "widgets": [
            { "id": "w1", "type": "pie", "size": "md", "groupBy": "service", "extra": "dropme" },
            { "id": "w2", "type": "summary", "size": "sm", "metric": "total" },
        ] }] }] });
        let y = views_config_to_yaml(&cfg);
        let w0 = &y["views"][0]["rows"][0]["widgets"][0];
        assert_eq!(w0["groupBy"], json!("service"));
        assert!(w0.get("extra").is_none(), "unknown widget fields stripped");
        let w1 = &y["views"][0]["rows"][0]["widgets"][1];
        assert_eq!(w1["metric"], json!("total"));
    }
}
