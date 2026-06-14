//! Loads the YAML config + org-account JSON and reshapes into the JSON shapes
//! the CostApi returns. YAML keys are already camelCase, so most reads are a
//! near passthrough; `dimensions_flat` mirrors the desktop `config:dimensions`
//! handler. Org-account data drives tag fallbacks + account-name resolution.

use serde::Deserialize;
use serde_json::{json, Map, Value as J};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuiltIn {
    pub name: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub display_field: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub normalize: Option<String>,
    #[serde(default)]
    pub aliases: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub account_name_from_tag: Option<String>,
    #[serde(default)]
    pub use_region_names: Option<bool>,
    #[serde(default)]
    pub default_filter_values: Option<Vec<String>>,
}

#[derive(Deserialize, Clone, Default)]
pub struct PathSeg {
    pub separator: String,
    pub index: i64,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    #[serde(default)]
    pub tag_name: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub concept: Option<String>,
    #[serde(default)]
    pub normalize: Option<String>,
    #[serde(default)]
    pub aliases: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub account_tag_fallback: Option<String>,
    #[serde(default)]
    pub missing_value_template: Option<String>,
    #[serde(default)]
    pub path_segment: Option<PathSeg>,
    #[serde(default)]
    pub separator: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub default_filter_values: Option<Vec<String>>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dimensions {
    #[serde(default)]
    pub built_in: Vec<BuiltIn>,
    #[serde(default)]
    pub tags: Vec<Tag>,
}

impl Dimensions {
    pub fn account_built_in(&self) -> Option<&BuiltIn> {
        self.built_in.iter().find(|b| b.field == "account_id")
    }
}

#[derive(Deserialize, Clone, Default)]
pub struct ExclusionCondition {
    #[serde(rename = "dimensionId")]
    pub dimension_id: String,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Deserialize, Clone, Default)]
pub struct ExclusionRule {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub conditions: Vec<ExclusionCondition>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostScope {
    #[serde(default)]
    pub cost_metric: Option<String>,
    #[serde(default)]
    pub cost_perspective: Option<String>,
    #[serde(default)]
    pub rules: Vec<ExclusionRule>,
}

/// Normalize the YAML costMetric (which may be 'UnblendedCost' / 'list' / etc.)
/// to the source's metric vocabulary: unblended | amortized | list.
pub fn normalize_metric(raw: &Option<String>) -> String {
    match raw.as_deref() {
        Some("list") | Some("ListCost") => "list".to_string(),
        Some("amortized") | Some("AmortizedCost") => "amortized".to_string(),
        _ => "unblended".to_string(),
    }
}

pub fn load_yaml_json(path: &Path) -> Result<J, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_yaml::from_str::<J>(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub fn load_dimensions(config_dir: &Path) -> Result<Dimensions, String> {
    let v = load_yaml_json(&config_dir.join("dimensions.yaml"))?;
    serde_json::from_value::<Dimensions>(v).map_err(|e| format!("dimensions shape: {e}"))
}

pub fn load_cost_scope(config_dir: &Path) -> CostScope {
    // Cost scope is optional — absence means no metric override / no exclusions.
    match load_yaml_json(&config_dir.join("cost-scope.yaml")) {
        Ok(v) => serde_json::from_value::<CostScope>(v).unwrap_or_default(),
        Err(_) => CostScope::default(),
    }
}

/// id -> display name, resolved like the desktop getAccountMap: when the account
/// dimension sets accountNameFromTag, use that org tag; otherwise the account
/// `name`. Read from org-accounts.json next to the data dir.
pub fn load_account_name_map(data_dir: &Path, name_from_tag: Option<&str>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(base) = data_dir.parent() else { return map };
    let path = base.join("org-accounts.json");
    let Ok(raw) = std::fs::read_to_string(&path) else { return map };
    let Ok(v) = serde_json::from_str::<J>(&raw) else { return map };
    let Some(accounts) = v.get("accounts").and_then(|a| a.as_array()) else { return map };
    for acct in accounts {
        let Some(id) = acct.get("id").and_then(|x| x.as_str()) else { continue };
        if id.is_empty() {
            continue;
        }
        let resolved = name_from_tag
            .and_then(|key| acct.get("tags").and_then(|t| t.get(key)).and_then(|x| x.as_str()))
            .filter(|s| !s.is_empty())
            .or_else(|| acct.get("name").and_then(|x| x.as_str()))
            .unwrap_or("");
        if !resolved.is_empty() {
            map.insert(id.to_string(), resolved.to_string());
        }
    }
    map
}

/// Path to the flattened org-account tags file (`[{id, tags, ouPath}]`) the
/// source LEFT JOINs for tag fallbacks. None when absent.
pub fn org_tags_path(data_dir: &Path) -> Option<String> {
    let base = data_dir.parent()?;
    let p = base.join("org-account-tags.json");
    if p.is_file() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Mirror of the desktop `config:dimensions` handler: flatten built-ins + tags,
/// dropping disabled ones, into the `Dimension[]` the UI consumes.
pub fn dimensions_flat(dims: &Dimensions) -> J {
    let mut arr: Vec<J> = vec![];
    for b in &dims.built_in {
        if b.enabled == Some(false) {
            continue;
        }
        let mut o = Map::new();
        o.insert("name".into(), json!(b.name));
        o.insert("label".into(), json!(b.label));
        o.insert("field".into(), json!(b.field));
        if let Some(df) = &b.display_field {
            o.insert("displayField".into(), json!(df));
        }
        if let Some(dfv) = &b.default_filter_values {
            if !dfv.is_empty() {
                o.insert("defaultFilterValues".into(), json!(dfv));
            }
        }
        arr.push(J::Object(o));
    }
    for t in &dims.tags {
        if t.enabled == Some(false) {
            continue;
        }
        let mut o = Map::new();
        if let Some(tn) = &t.tag_name {
            if !tn.is_empty() {
                o.insert("tagName".into(), json!(tn));
            }
        }
        o.insert("label".into(), json!(t.label));
        if let Some(c) = &t.concept {
            o.insert("concept".into(), json!(c));
        }
        if let Some(n) = &t.normalize {
            o.insert("normalize".into(), json!(n));
        }
        if let Some(s) = &t.separator {
            o.insert("separator".into(), json!(s));
        }
        if let Some(a) = &t.aliases {
            o.insert("aliases".into(), json!(a));
        }
        if let Some(f) = &t.account_tag_fallback {
            o.insert("accountTagFallback".into(), json!(f));
        }
        if let Some(dfv) = &t.default_filter_values {
            if !dfv.is_empty() {
                o.insert("defaultFilterValues".into(), json!(dfv));
            }
        }
        arr.push(J::Object(o));
    }
    J::Array(arr)
}
