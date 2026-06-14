//! Loads the YAML config fixtures and reshapes them into the JSON shapes the
//! CostApi returns. YAML keys are already camelCase, so most reads are a near
//! passthrough; `dimensions_flat` mirrors the desktop `config:dimensions`
//! handler (flatten + drop disabled).

use serde::Deserialize;
use serde_json::{json, Map, Value as J};
use std::collections::BTreeMap;
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
    pub default_filter_values: Option<Vec<String>>,
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

pub fn load_yaml_json(path: &Path) -> Result<J, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_yaml::from_str::<J>(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub fn load_dimensions(config_dir: &Path) -> Result<Dimensions, String> {
    let v = load_yaml_json(&config_dir.join("dimensions.yaml"))?;
    serde_json::from_value::<Dimensions>(v).map_err(|e| format!("dimensions shape: {e}"))
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
