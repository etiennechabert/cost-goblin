//! Tauri commands implementing the read half of CostApi over a real (or
//! fixture) CUR dataset: org-account join, cost-metric + cost-scope from
//! cost-scope.yaml, and account-name resolution. Results are shaped exactly
//! like the TS handlers.

use crate::config::{self, Dimensions, MarketplaceRule};
use crate::db::{self, f64_at, str_at};
use crate::query::{self, available_periods, build_source, list_local_months, QueryArgs};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value as J};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub data_dir: String,
    pub config_dir: PathBuf,
    pub app_version: String,
}

type R = Result<J, String>;

// --- request context: dims + cost metric/scope + org-account maps ---

pub struct ReqCtx {
    pub dims: Dimensions,
    pub metric: String,
    pub net: bool,
    pub exclusions: Vec<String>,
    pub org_path: Option<String>,
    pub marketplace: Vec<MarketplaceRule>,
    pub account_name_map: HashMap<String, String>,
    pub account_reverse: HashMap<String, Vec<String>>,
}

impl ReqCtx {
    pub fn is_account_group(&self, group_by: &str) -> bool {
        group_by == "account_id"
            || self.dims.account_built_in().map_or(false, |b| b.name == group_by)
    }
    pub fn source(&self, data_dir: &str, tier: &str, periods: &[String], metric: &str, net: bool) -> String {
        build_source(data_dir, tier, periods, metric, net, &self.dims, self.org_path.as_deref(), &self.marketplace)
    }
    pub fn args<'a>(&'a self, source: &'a str, with_exclusions: bool) -> QueryArgs<'a> {
        QueryArgs {
            dims: &self.dims,
            source,
            exclusions: if with_exclusions { &self.exclusions } else { &[] },
            account_reverse: Some(&self.account_reverse),
        }
    }
    pub fn map_account(&self, id: &str) -> String {
        self.account_name_map.get(id).cloned().unwrap_or_else(|| id.to_string())
    }
}

/// Build the request context (dims + cost metric/scope + org-account maps) from
/// raw dirs — reused by the Tauri commands and the MCP server.
pub fn req_ctx_from(data_dir: &str, config_dir: &Path) -> Result<ReqCtx, String> {
    let dims = config::load_dimensions(config_dir)?;
    let cs = config::load_cost_scope(config_dir);
    let metric = config::normalize_metric(&cs.cost_metric);
    let net = cs.cost_perspective.as_deref() == Some("net");
    let exclusions = query::build_exclusion_clauses(&cs, &dims);
    let marketplace = cs.active_marketplace_rules();
    let org_path = config::org_tags_path(Path::new(data_dir));
    let name_from_tag = dims.account_built_in().and_then(|b| b.account_name_from_tag.clone());
    let account_name_map = config::load_account_name_map(Path::new(data_dir), name_from_tag.as_deref());
    let mut account_reverse: HashMap<String, Vec<String>> = HashMap::new();
    for (id, name) in &account_name_map {
        account_reverse.entry(name.clone()).or_default().push(id.clone());
    }
    Ok(ReqCtx { dims, metric, net, exclusions, org_path, marketplace, account_name_map, account_reverse })
}

fn req_ctx(state: &AppState) -> Result<ReqCtx, String> {
    req_ctx_from(&state.data_dir, &state.config_dir)
}

/// Raw fields a dashboard query touches (group_by + active filters + extras).
/// None when any dim is unresolvable — then we don't risk routing to the rollup.
fn dashboard_fields(dims: &Dimensions, group_by: &str, filters: &Map<String, J>, extra: &[&str]) -> Option<Vec<String>> {
    let mut f = vec![query::resolve_field(group_by, dims)?.raw_field];
    for k in filters.keys() {
        f.push(query::resolve_field(k, dims)?.raw_field);
    }
    f.extend(extra.iter().map(|s| (*s).to_string()));
    Some(f)
}

/// Pick the query source: the pre-aggregated rollup (exclusions baked in → no
/// re-exclude) when every touched field is in-grain and every period is rolled
/// up, else the raw org-joined source. Returns (source, apply_exclusions).
fn pick_source(ctx: &ReqCtx, data_dir: &str, tier: &str, periods: &[String], group_by: &str, filters: &Map<String, J>, extra: &[&str]) -> (String, bool) {
    let rollup = dashboard_fields(&ctx.dims, group_by, filters, extra)
        .and_then(|nf| crate::rollup::rollup_source(data_dir, tier, periods, &nf));
    match rollup {
        Some(rs) => (rs, false),
        None => (ctx.source(data_dir, tier, periods, &ctx.metric, ctx.net), true),
    }
}

// --- param helpers ---

fn pobj(params: &J) -> Map<String, J> {
    params.as_object().cloned().unwrap_or_default()
}
fn pstr<'a>(o: &'a Map<String, J>, key: &str) -> Option<&'a str> {
    o.get(key).and_then(|v| v.as_str())
}
fn date_range(o: &Map<String, J>) -> Option<(String, String)> {
    let dr = o.get("dateRange")?.as_object()?;
    Some((dr.get("start")?.as_str()?.to_string(), dr.get("end")?.as_str()?.to_string()))
}
fn filters_map(o: &Map<String, J>) -> Map<String, J> {
    o.get("filters").and_then(|v| v.as_object()).cloned().unwrap_or_default()
}
fn tier_of(o: &Map<String, J>) -> &'static str {
    if pstr(o, "granularity") == Some("hourly") { "hourly" } else { "daily" }
}

// --- config reads ---

#[tauri::command(async)]
pub fn get_app_version(state: tauri::State<AppState>) -> Result<String, String> {
    Ok(state.app_version.clone())
}

// --- auto-updater ---
//
// The command surface + status state machine are ported (the renderer's
// ReleaseNotesModal + onStatusChanged subscription work end-to-end). Actually
// *finding* an update needs a Tauri-format signed release feed — the project's
// GitHub releases are electron-builder format, so there's nothing for Tauri's
// updater to consume yet. Until that feed + EdDSA signing exist, a check
// honestly reports "idle" (up to date). See specs/rust-tauri-migration.md.

#[tauri::command(async)]
pub fn check_for_updates() -> R {
    Ok(json!({ "state": "idle" }))
}
#[tauri::command(async)]
pub fn download_update() -> R {
    Ok(json!({ "state": "idle" }))
}
#[tauri::command(async)]
pub fn quit_and_install() -> Result<(), String> {
    // No downloaded update in the spike (no Tauri feed) → nothing to install.
    Ok(())
}

/// Real read of ~/.aws/config + ~/.aws/credentials (no SDK / network) — the
/// one piece of the AWS surface that's purely local.
#[tauri::command(async)]
pub fn list_aws_profiles() -> R {
    use std::collections::BTreeSet;
    let home = std::env::var("HOME").unwrap_or_default();
    let mut set: BTreeSet<String> = BTreeSet::new();
    let section_name = |line: &str, strip_profile: bool| -> Option<String> {
        let l = line.trim();
        if l.starts_with('[') && l.ends_with(']') {
            let inner = l[1..l.len() - 1].trim();
            let name = if strip_profile { inner.strip_prefix("profile ").unwrap_or(inner).trim() } else { inner };
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
        None
    };
    if let Ok(s) = std::fs::read_to_string(format!("{home}/.aws/config")) {
        for line in s.lines() {
            if let Some(n) = section_name(line, true) {
                set.insert(n);
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string(format!("{home}/.aws/credentials")) {
        for line in s.lines() {
            if let Some(n) = section_name(line, false) {
                set.insert(n);
            }
        }
    }
    Ok(json!(set.into_iter().collect::<Vec<_>>()))
}

/// Real AWS Organizations sync (read-only) via aws-sdk-organizations using the
/// named SSO/profile. Refreshes org-accounts.json + the flat tag-join file.
#[tauri::command]
pub async fn sync_org_accounts(params: J, state: tauri::State<'_, AppState>) -> R {
    let data_dir = state.data_dir.clone();
    let profile = params.get("profile").and_then(|v| v.as_str()).unwrap_or("default").to_string();
    let result = crate::aws_org::sync(&profile, Path::new(&data_dir)).await?;
    // Piggyback the SSM region-name sync (non-fatal — display nicety; the user
    // already paid the auth cost). Failure is captured in get_region_names_info.
    let _ = crate::aws_ssm::sync(&profile, Path::new(&data_dir)).await;
    Ok(result)
}

/// Reads the persisted org-accounts.json so the Data Management card shows the
/// real account count (after a sync, or from a prior sync).
#[tauri::command(async)]
pub fn get_org_sync_result(state: tauri::State<AppState>) -> R {
    Ok(crate::aws_org::read_result(Path::new(&state.data_dir)))
}

/// Standalone SSM region-name resync (doesn't drag the slow org sync along).
#[tauri::command]
pub async fn sync_region_names(params: J, state: tauri::State<'_, AppState>) -> R {
    let profile = params.get("profile").and_then(|v| v.as_str()).unwrap_or("default").to_string();
    let map = crate::aws_ssm::sync(&profile, Path::new(&state.data_dir)).await?;
    let count = map.get("regions").and_then(|r| r.as_object()).map(|o| o.len()).unwrap_or(0);
    Ok(json!({ "count": count, "syncedAt": map.get("syncedAt").cloned().unwrap_or(J::Null) }))
}

#[tauri::command(async)]
pub fn get_region_names_info(state: tauri::State<AppState>) -> R {
    Ok(crate::aws_ssm::read_info(Path::new(&state.data_dir)))
}

#[tauri::command(async)]
pub fn clear_org_data(state: tauri::State<AppState>) -> Result<(), String> {
    crate::aws_ssm::clear(Path::new(&state.data_dir));
    Ok(())
}

/// Debug panel: live query log (sql, timing, rows) recorded by db::query_map.
#[tauri::command(async)]
pub fn get_query_log() -> R {
    Ok(crate::querylog::snapshot())
}

#[tauri::command(async)]
pub fn clear_query_log() -> Result<(), String> {
    crate::querylog::clear();
    Ok(())
}

#[tauri::command(async)]
pub fn run_explain(params: J) -> Result<String, String> {
    let id = params.get("queryId").and_then(|v| v.as_i64()).unwrap_or(-1);
    match crate::querylog::sql_for(id) {
        Some(sql) => Ok(format!("-- generated SQL (parameters bound separately)\n{sql}")),
        None => Ok(String::new()),
    }
}

#[tauri::command(async)]
pub fn get_config(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("costgoblin.yaml"))
}
#[tauri::command(async)]
pub fn get_dimensions(state: tauri::State<AppState>) -> R {
    Ok(config::dimensions_flat(&config::load_dimensions(&state.config_dir)?))
}
#[tauri::command(async)]
pub fn get_dimensions_config(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("dimensions.yaml"))
}
#[tauri::command(async)]
pub fn get_org_tree(state: tauri::State<AppState>) -> R {
    // org-tree.yaml is optional — absent means an empty tree.
    match config::load_yaml_json(&state.config_dir.join("org-tree.yaml")) {
        Ok(v) => Ok(v.get("tree").cloned().unwrap_or_else(|| json!([]))),
        Err(_) => Ok(json!([])),
    }
}
#[tauri::command(async)]
pub fn get_views_config(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("views.yaml"))
}
#[tauri::command(async)]
pub fn get_cost_scope(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("cost-scope.yaml"))
}
// Preferences live as JSON next to the data dir (userData root), like Electron.
fn prefs_path(state: &AppState, name: &str) -> PathBuf {
    Path::new(&state.data_dir)
        .parent()
        .unwrap_or(Path::new("/"))
        .join(format!("{name}.json"))
}
fn read_json_or(path: &Path, default: J) -> J {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<J>(&s).ok())
        .unwrap_or(default)
}
fn write_json(path: &Path, value: &J) -> Result<(), String> {
    std::fs::write(path, serde_json::to_string_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {}: {e}", path.display()))
}
fn open_path(p: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open {}: {e}", p.display()))
}

#[tauri::command(async)]
pub fn get_ui_preferences(state: tauri::State<AppState>) -> R {
    Ok(read_json_or(&prefs_path(&state, "ui-preferences"), json!({ "theme": "dark", "palette": "standard" })))
}
#[tauri::command(async)]
pub fn save_ui_preferences(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    write_json(&prefs_path(&state, "ui-preferences"), &params)
}
#[tauri::command(async)]
pub fn get_explorer_preferences(state: tauri::State<AppState>) -> R {
    Ok(read_json_or(&prefs_path(&state, "explorer-preferences"), json!({ "hiddenColumns": [], "columnOrder": [] })))
}
#[tauri::command(async)]
pub fn save_explorer_preferences(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    write_json(&prefs_path(&state, "explorer-preferences"), &params)
}
#[tauri::command(async)]
pub fn get_savings_preferences(state: tauri::State<AppState>) -> R {
    Ok(read_json_or(&prefs_path(&state, "savings-preferences"), json!({ "hiddenActionTypes": [] })))
}
#[tauri::command(async)]
pub fn save_savings_preferences(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    write_json(&prefs_path(&state, "savings-preferences"), &params)
}
// --- config writes (YAML) ---

#[tauri::command(async)]
pub fn save_dimensions_config(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    crate::config_write::save_dimensions(&state.config_dir, &params)
}
#[tauri::command(async)]
pub fn save_views_config(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    crate::config_write::save_views(&state.config_dir, &params)
}
#[tauri::command(async)]
pub fn save_cost_scope(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    crate::config_write::save_cost_scope(&state.config_dir, &params)
}
#[tauri::command(async)]
pub fn update_aws_profile(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    let profile = pstr(&pobj(&params), "profile").unwrap_or("").to_string();
    crate::config_write::update_aws_profile(&state.config_dir, &profile)
}

#[tauri::command(async)]
pub fn open_data_folder(state: tauri::State<AppState>) -> Result<(), String> {
    open_path(Path::new(&state.data_dir))
}
#[tauri::command(async)]
pub fn reveal_config_folder(state: tauri::State<AppState>) -> Result<(), String> {
    open_path(&state.config_dir)
}

// --- S3 CUR sync ---

/// (profile, sync-object) from costgoblin.yaml's first provider.
fn resolve_provider(state: &AppState) -> Result<(String, J), String> {
    let cfg = config::load_yaml_json(&state.config_dir.join("costgoblin.yaml"))?;
    let p = cfg.get("providers").and_then(|v| v.as_array()).and_then(|a| a.first()).ok_or("No provider configured")?;
    let profile = p.get("credentials").and_then(|c| c.get("profile")).and_then(|v| v.as_str()).unwrap_or("default").to_string();
    Ok((profile, p.get("sync").cloned().unwrap_or_else(|| json!({}))))
}
fn bucket_for_tier(sync: &J, tier: &str) -> Option<String> {
    let daily = sync.get("daily").and_then(|d| d.get("bucket")).and_then(|v| v.as_str());
    let pick = match tier {
        "hourly" => sync.get("hourly").and_then(|d| d.get("bucket")).and_then(|v| v.as_str()).or(daily),
        "cost-optimization" => sync.get("costOptimization").and_then(|d| d.get("bucket")).and_then(|v| v.as_str()),
        _ => daily,
    };
    pick.map(|s| s.to_string())
}

/// Real remote inventory via S3 ListObjectsV2 (so the user can pick periods to
/// sync), falling back to a local-only scan when no bucket is configured or S3
/// is unreachable (offline / SSO expired) so the app still shows local data.
#[tauri::command]
pub async fn get_data_inventory(params: J, state: tauri::State<'_, AppState>) -> R {
    let tier = pstr(&pobj(&params), "tier").unwrap_or("daily").to_string();
    let data_dir = state.data_dir.clone();
    if let Ok((profile, sync)) = resolve_provider(state.inner()) {
        if let Some(bucket) = bucket_for_tier(&sync, &tier) {
            if let Ok(v) = crate::sync::remote_inventory(&bucket, &profile, &data_dir, &tier).await {
                return Ok(v);
            }
        }
    }
    Ok(crate::sync::local_inventory(&data_dir, &tier))
}

fn tier_from_sync_id(sync_id: &str) -> &'static str {
    match sync_id {
        "hourly" => "hourly",
        "cost-optimization" => "cost-optimization",
        _ => "daily",
    }
}

/// Download the selected CUR Parquet files via the `aws s3 sync` CLI. Runs on a
/// worker thread (`#[tauri::command(async)]` on a sync fn) so the blocking
/// subprocess + progress parsing never touches the UI thread.
#[tauri::command(async)]
pub fn sync_periods(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let files = o.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let sync_id = pstr(&o, "syncId").unwrap_or("default").to_string();
    let tier = tier_from_sync_id(&sync_id);
    let (profile, sync) = resolve_provider(state.inner())?;
    let bucket = bucket_for_tier(&sync, tier).ok_or("No bucket configured for this tier")?;
    let (downloaded, rows) = crate::sync::sync_periods(&files, tier, &profile, &bucket, &state.data_dir, &sync_id)?;
    Ok(json!({ "filesDownloaded": downloaded, "rowsProcessed": rows }))
}

#[tauri::command(async)]
pub fn cancel_sync(params: J) -> Result<(), String> {
    crate::sync::cancel(pstr(&pobj(&params), "syncId").unwrap_or("default"));
    Ok(())
}

#[tauri::command(async)]
pub fn delete_local_period(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    let o = pobj(&params);
    let period = pstr(&o, "period").ok_or("missing period")?;
    let tier = pstr(&o, "tier").unwrap_or("daily");
    crate::sync::delete_local_period(period, tier, &state.data_dir)
}

#[tauri::command(async)]
pub fn get_sync_status(params: J) -> R {
    Ok(crate::sync::status(pstr(&pobj(&params), "syncId").unwrap_or("default")))
}

/// Kick off `aws sso login --profile <profile>` (detached) — the Data
/// Management "Sign in" button.
#[tauri::command(async)]
pub fn sso_login(params: J) -> Result<(), String> {
    let profile = pstr(&pobj(&params), "profile").unwrap_or("default").to_string();
    std::process::Command::new(crate::sync::find_aws_cli())
        .args(["sso", "login", "--profile", &profile])
        .spawn()
        .map(|_| ())
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "AWS CLI not found — install it with: brew install awscli".to_string() } else { format!("aws sso login: {e}") })
}

// --- cost queries ---

#[tauri::command(async)]
pub fn query_costs(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let group_by = pstr(&o, "groupBy").ok_or("query_costs: missing groupBy")?;
    let (start, end) = date_range(&o).ok_or("query_costs: missing dateRange")?;
    let ctx = req_ctx(&state)?;
    let tier = tier_of(&o);
    let periods = available_periods(&state.data_dir, tier, &start, &end);
    if periods.is_empty() {
        return Ok(json!({ "rows": [], "totalCost": 0.0, "topServices": [], "dateRange": o.get("dateRange").cloned().unwrap_or(J::Null) }));
    }
    let (source, apply_excl) = pick_source(&ctx, &state.data_dir, tier, &periods, group_by, &filters_map(&o), &["service"]);
    let args = ctx.args(&source, apply_excl);
    let built = query::cost_query(group_by, &start, &end, &filters_map(&o), &args)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| {
        (str_at(row, 0), f64_at(row, 1), str_at(row, 2), f64_at(row, 3))
    })?;

    let is_acct = ctx.is_account_group(group_by);
    // Pass 1: accumulate per RAW entity (total set once per entity, like core's
    // buildCostResult). Pass 2: merge by display name (account ids → one name).
    let mut raw_order: Vec<String> = vec![];
    let mut raw_total: HashMap<String, f64> = HashMap::new();
    let mut raw_services: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut service_totals: HashMap<String, f64> = HashMap::new();
    for (entity, total, service, scost) in rows {
        if !raw_total.contains_key(&entity) {
            raw_order.push(entity.clone());
            raw_total.insert(entity.clone(), total);
            raw_services.insert(entity.clone(), HashMap::new());
        }
        if !service.is_empty() {
            *raw_services.get_mut(&entity).unwrap().entry(service.clone()).or_insert(0.0) += scost;
            *service_totals.entry(service).or_insert(0.0) += scost;
        }
    }
    let mut order: Vec<String> = vec![];
    let mut totals: HashMap<String, f64> = HashMap::new();
    let mut services: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for raw in &raw_order {
        let key = if is_acct { ctx.map_account(raw) } else { raw.clone() };
        if !totals.contains_key(&key) {
            order.push(key.clone());
            totals.insert(key.clone(), 0.0);
            services.insert(key.clone(), HashMap::new());
        }
        *totals.get_mut(&key).unwrap() += raw_total.get(raw).copied().unwrap_or(0.0);
        let svc = services.get_mut(&key).unwrap();
        for (s, c) in raw_services.get(raw).into_iter().flatten() {
            *svc.entry(s.clone()).or_insert(0.0) += c;
        }
    }
    let total_cost: f64 = totals.values().sum();
    let mut svc_sorted: Vec<(String, f64)> = service_totals.into_iter().collect();
    svc_sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top_services: Vec<J> = svc_sorted.iter().take(5).map(|(s, _)| json!(s)).collect();
    let mut entries: Vec<String> = order;
    entries.sort_by(|a, b| totals[b].partial_cmp(&totals[a]).unwrap_or(std::cmp::Ordering::Equal));
    let cost_rows: Vec<J> = entries
        .iter()
        .map(|e| {
            let svc: Map<String, J> = services.get(e).cloned().unwrap_or_default().into_iter().map(|(k, v)| (k, json!(v))).collect();
            json!({ "entity": e, "totalCost": totals[e], "serviceCosts": svc })
        })
        .collect();
    Ok(json!({ "rows": cost_rows, "totalCost": total_cost, "topServices": top_services, "dateRange": o.get("dateRange").cloned().unwrap_or(J::Null) }))
}

#[tauri::command(async)]
pub fn query_daily_costs(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let group_by = pstr(&o, "groupBy").ok_or("query_daily_costs: missing groupBy")?;
    let (start, end) = date_range(&o).ok_or("query_daily_costs: missing dateRange")?;
    let ctx = req_ctx(&state)?;
    let tier = tier_of(&o);
    let periods = available_periods(&state.data_dir, tier, &start, &end);
    if periods.is_empty() {
        return Ok(json!({ "days": [], "groups": [], "totalCost": 0.0 }));
    }
    let (source, apply_excl) = pick_source(&ctx, &state.data_dir, tier, &periods, group_by, &filters_map(&o), &[]);
    let args = ctx.args(&source, apply_excl);
    let built = query::daily_costs_query(group_by, &start, &end, &filters_map(&o), &args)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| (str_at(row, 0), str_at(row, 1), f64_at(row, 2)))?;

    let is_acct = ctx.is_account_group(group_by);
    let mut day_order: Vec<String> = vec![];
    let mut days: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut group_totals: HashMap<String, f64> = HashMap::new();
    let mut total_cost = 0.0;
    for (date, raw_group, cost) in rows {
        let group = if is_acct { ctx.map_account(&raw_group) } else { raw_group };
        if !days.contains_key(&date) {
            day_order.push(date.clone());
            days.insert(date.clone(), HashMap::new());
        }
        *days.get_mut(&date).unwrap().entry(group.clone()).or_insert(0.0) += cost;
        *group_totals.entry(group).or_insert(0.0) += cost;
        total_cost += cost;
    }
    day_order.sort();
    let day_rows: Vec<J> = day_order
        .iter()
        .map(|d| {
            let breakdown = days.get(d).cloned().unwrap_or_default();
            let total: f64 = breakdown.values().sum();
            let bmap: Map<String, J> = breakdown.into_iter().map(|(k, v)| (k, json!(v))).collect();
            json!({ "date": d, "total": total, "breakdown": bmap })
        })
        .collect();
    let mut groups: Vec<(String, f64)> = group_totals.into_iter().collect();
    groups.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let group_names: Vec<J> = groups.into_iter().map(|(g, _)| json!(g)).collect();
    Ok(json!({ "days": day_rows, "groups": group_names, "totalCost": total_cost }))
}

#[tauri::command(async)]
pub fn query_trends(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let group_by = pstr(&o, "groupBy").ok_or("query_trends: missing groupBy")?;
    let (start, end) = date_range(&o).ok_or("query_trends: missing dateRange")?;
    let delta_threshold = o.get("deltaThreshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let percent_threshold = o.get("percentThreshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ctx = req_ctx(&state)?;
    let periods = query::trend_periods(&state.data_dir, &start, &end);
    if periods.is_empty() {
        return Ok(json!({ "increases": [], "savings": [], "totalIncrease": 0.0, "totalSavings": 0.0 }));
    }
    let (source, apply_excl) = pick_source(&ctx, &state.data_dir, "daily", &periods, group_by, &filters_map(&o), &[]);
    let args = ctx.args(&source, apply_excl);
    let built = query::trend_query(group_by, &start, &end, delta_threshold, &filters_map(&o), &args)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| {
        (str_at(row, 0), f64_at(row, 1), f64_at(row, 2), f64_at(row, 3), f64_at(row, 4))
    })?;
    let is_acct = ctx.is_account_group(group_by);
    // merge by display entity (account ids -> name)
    let mut agg: HashMap<String, (f64, f64, f64)> = HashMap::new();
    let mut order: Vec<String> = vec![];
    for (raw_entity, current, previous, delta, _pct) in rows {
        let entity = if is_acct { ctx.map_account(&raw_entity) } else { raw_entity };
        let e = agg.entry(entity.clone()).or_insert_with(|| { order.push(entity.clone()); (0.0, 0.0, 0.0) });
        e.0 += current;
        e.1 += previous;
        e.2 += delta;
    }
    let mut increases = vec![];
    let mut savings = vec![];
    let mut total_increase = 0.0;
    let mut total_savings = 0.0;
    for entity in order {
        let (current, previous, delta) = agg[&entity];
        let pct = if previous == 0.0 { if current == 0.0 { 0.0 } else { 100.0 } } else { delta / previous * 100.0 };
        if delta.abs() < delta_threshold || pct.abs() < percent_threshold {
            continue;
        }
        let row = json!({ "entity": entity, "currentCost": current, "previousCost": previous, "delta": delta, "percentChange": pct });
        if delta > 0.0 { total_increase += delta; increases.push(row); }
        else { total_savings += delta.abs(); savings.push(row); }
    }
    Ok(json!({ "increases": increases, "savings": savings, "totalIncrease": total_increase, "totalSavings": total_savings }))
}

#[tauri::command(async)]
pub fn query_entity_detail(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let dimension = pstr(&o, "dimension").ok_or("query_entity_detail: missing dimension")?;
    let entity = pstr(&o, "entity").ok_or("query_entity_detail: missing entity")?;
    let (start, end) = date_range(&o).ok_or("query_entity_detail: missing dateRange")?;
    let ctx = req_ctx(&state)?;
    let periods = available_periods(&state.data_dir, "daily", &start, &end);
    let empty = json!({ "entity": entity, "totalCost": 0.0, "previousCost": 0.0, "percentChange": 0.0, "dailyCosts": [], "byAccount": [], "byService": [], "bySubEntity": [] });
    if periods.is_empty() {
        return Ok(empty);
    }
    let source = ctx.source(&state.data_dir, "daily", &periods, &ctx.metric, ctx.net);
    let args = ctx.args(&source, true);
    let built = query::entity_detail_query(dimension, entity, &start, &end, &filters_map(&o), &args)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| {
        (str_at(row, 0), str_at(row, 1), str_at(row, 2), str_at(row, 3), f64_at(row, 4))
    })?;
    let mut day_order: Vec<String> = vec![];
    let mut day_cost: HashMap<String, f64> = HashMap::new();
    let mut day_svc: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut day_acct: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut by_account: HashMap<String, f64> = HashMap::new();
    let mut by_service: HashMap<String, f64> = HashMap::new();
    let mut total = 0.0;
    for (date, service, account_id, _account_name, cost) in rows {
        let acct = ctx.map_account(&account_id);
        if !day_cost.contains_key(&date) {
            day_order.push(date.clone());
            day_cost.insert(date.clone(), 0.0);
            day_svc.insert(date.clone(), HashMap::new());
            day_acct.insert(date.clone(), HashMap::new());
        }
        *day_cost.get_mut(&date).unwrap() += cost;
        *day_svc.get_mut(&date).unwrap().entry(service.clone()).or_insert(0.0) += cost;
        *day_acct.get_mut(&date).unwrap().entry(acct.clone()).or_insert(0.0) += cost;
        *by_account.entry(acct).or_insert(0.0) += cost;
        *by_service.entry(service).or_insert(0.0) += cost;
        total += cost;
    }
    day_order.sort();
    let daily_costs: Vec<J> = day_order
        .iter()
        .map(|d| {
            let bd: Map<String, J> = day_svc.get(d).cloned().unwrap_or_default().into_iter().map(|(k, v)| (k, json!(v))).collect();
            let ba: Map<String, J> = day_acct.get(d).cloned().unwrap_or_default().into_iter().map(|(k, v)| (k, json!(v))).collect();
            json!({ "date": d, "cost": day_cost.get(d).copied().unwrap_or(0.0), "breakdown": bd, "breakdownByAccount": ba })
        })
        .collect();
    let to_slices = |m: HashMap<String, f64>| -> Vec<J> {
        let mut v: Vec<(String, f64)> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().map(|(name, cost)| json!({ "name": name, "cost": cost, "percentage": if total > 0.0 { cost / total * 100.0 } else { 0.0 } })).collect()
    };
    Ok(json!({ "entity": entity, "totalCost": total, "previousCost": 0.0, "percentChange": 0.0, "dailyCosts": daily_costs, "byAccount": to_slices(by_account), "byService": to_slices(by_service), "bySubEntity": [] }))
}

#[tauri::command(async)]
pub fn get_filter_values(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let dim_id = pstr(&o, "dimensionId").ok_or("get_filter_values: missing dimensionId")?;
    let ctx = req_ctx(&state)?;
    let (start, end) = match o.get("dateRange").and_then(|v| v.as_object()) {
        Some(dr) => (
            dr.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            dr.get("end").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        None => (String::new(), String::new()),
    };
    let has_range = query::valid_date(&start) && query::valid_date(&end);
    let periods = if has_range { available_periods(&state.data_dir, "daily", &start, &end) } else { list_local_months(&state.data_dir, "daily") };
    if periods.is_empty() {
        return Ok(json!([]));
    }
    let source = ctx.source(&state.data_dir, "daily", &periods, &ctx.metric, ctx.net);
    let args = ctx.args(&source, true);
    let built = query::filter_values_query(dim_id, &start, &end, &filters_map(&o), &args)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| (str_at(row, 0), f64_at(row, 1)))?;
    let is_acct = ctx.is_account_group(dim_id);
    if is_acct {
        let mut merged: HashMap<String, f64> = HashMap::new();
        let mut order: Vec<String> = vec![];
        for (id, cost) in rows {
            let name = ctx.map_account(&id);
            if !merged.contains_key(&name) { order.push(name.clone()); }
            *merged.entry(name).or_insert(0.0) += cost;
        }
        order.sort_by(|a, b| merged[b].partial_cmp(&merged[a]).unwrap_or(std::cmp::Ordering::Equal));
        let out: Vec<J> = order.into_iter().map(|n| { let c = merged[&n]; json!({ "value": n, "label": n, "count": c }) }).collect();
        return Ok(J::Array(out));
    }
    let out: Vec<J> = rows.into_iter().map(|(val, cost)| json!({ "value": val, "label": val, "count": cost })).collect();
    Ok(J::Array(out))
}

// --- explorer (uses params-driven metric/scope; org join for tag columns) ---

struct ExplorerCtx {
    empty: bool,
    source: String,
    where_sql: String,
    params: Vec<duckdb::types::Value>,
    tier: &'static str,
    start: String,
    end: String,
    window_days: i64,
    tag_columns: Vec<J>,
    rc: ReqCtx,
}

fn explorer_ctx(o: &Map<String, J>, state: &AppState) -> Result<ExplorerCtx, String> {
    let rc = req_ctx(state)?;
    let (start, end) = match date_range(o) {
        Some((s, e)) if query::valid_date(&s) && query::valid_date(&e) => (s, e),
        _ => {
            let now = query::epoch_days_now();
            (query::days_to_date(now - 2 - 29), query::days_to_date(now - 2))
        }
    };
    let tier = tier_of(o);
    let metric = if pstr(o, "costMetric") == Some("list") { "list" } else if pstr(o, "costMetric") == Some("amortized") { "amortized" } else { "unblended" };
    let net = pstr(o, "costPerspective") == Some("net");
    let apply_scope = o.get("applyCostScope").and_then(|v| v.as_bool()).unwrap_or(false);
    let window_days = query::window_days(&start, &end).max(1);
    let tag_columns: Vec<J> = rc.dims.tags.iter().map(|t| json!({ "id": query::tag_dim_column(t), "label": t.label })).collect();
    let periods = available_periods(&state.data_dir, tier, &start, &end);
    if periods.is_empty() {
        return Ok(ExplorerCtx { empty: true, source: String::new(), where_sql: String::new(), params: vec![], tier, start, end, window_days, tag_columns, rc });
    }
    let source = build_source(&state.data_dir, tier, &periods, metric, net, &rc.dims, rc.org_path.as_deref(), &rc.marketplace);
    let mut qb = db::Qb::new();
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'")];
    wheres.extend(query::filter_clauses(&filters_map(o), &rc.dims, Some(&rc.account_reverse), &mut qb));
    if apply_scope {
        wheres.extend(rc.exclusions.iter().cloned());
    }
    let where_sql = format!("WHERE {}", wheres.join(" AND "));
    Ok(ExplorerCtx { empty: false, source, where_sql, params: qb.params, tier, start, end, window_days, tag_columns, rc })
}

#[tauri::command(async)]
pub fn query_explorer_overview(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let ctx = explorer_ctx(&o, &state)?;
    if ctx.empty {
        return Ok(json!({ "windowDays": ctx.window_days, "startDate": ctx.start, "endDate": ctx.end, "dailyTotals": [], "totalRows": 0, "totalCost": 0.0, "tagColumns": ctx.tag_columns }));
    }
    let conn = db::open()?;
    let bucket = if ctx.tier == "hourly" { "date_trunc('hour', usage_hour + INTERVAL '30 minutes')" } else { "usage_date" };
    let totals_sql = format!("SELECT CAST(COALESCE(SUM(cost),0) AS DOUBLE) AS total_cost, CAST(COUNT(*) AS DOUBLE) AS total_rows FROM {} {}", ctx.source, ctx.where_sql);
    let daily_sql = format!("SELECT {bucket}::VARCHAR AS date, CAST(COALESCE(SUM(cost),0) AS DOUBLE) AS daily_cost, CAST(COUNT(*) AS DOUBLE) AS daily_rows FROM {} {} GROUP BY {bucket} ORDER BY {bucket}", ctx.source, ctx.where_sql);
    let totals = db::query_map(&conn, &totals_sql, &ctx.params, |r| (f64_at(r, 0), f64_at(r, 1)))?;
    let (total_cost, total_rows) = totals.first().copied().unwrap_or((0.0, 0.0));
    let daily = db::query_map(&conn, &daily_sql, &ctx.params, |r| json!({ "date": str_at(r, 0), "cost": f64_at(r, 1), "rows": f64_at(r, 2) }))?;
    Ok(json!({ "windowDays": ctx.window_days, "startDate": ctx.start, "endDate": ctx.end, "dailyTotals": daily, "totalRows": total_rows, "totalCost": total_cost, "tagColumns": ctx.tag_columns }))
}

#[tauri::command(async)]
pub fn query_explorer_rows(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let ctx = explorer_ctx(&o, &state)?;
    if ctx.empty {
        return Ok(json!({ "sampleRows": [], "tagColumns": ctx.tag_columns }));
    }
    let row_limit = o.get("rowLimit").and_then(|v| v.as_i64()).unwrap_or(500).clamp(1, 1000);
    let tag_ids: Vec<String> = ctx.rc.dims.tags.iter().map(|t| query::tag_dim_column(t)).collect();
    let tag_select = if tag_ids.is_empty() { String::new() } else { format!(",\n        {}", tag_ids.iter().map(|id| format!("COALESCE({id}, '') AS {id}")).collect::<Vec<_>>().join(",\n        ")) };
    let hour_select = if ctx.tier == "hourly" { "usage_hour::VARCHAR AS usage_hour" } else { "'' AS usage_hour" };
    let sql = format!(
        "SELECT usage_date::VARCHAR AS usage_date, {hour_select}, account_id, account_name, region, service, service_family, line_item_type, operation, usage_type, description, resource_id, CAST(usage_amount AS DOUBLE) AS usage_amount, CAST(cost AS DOUBLE) AS cost, CAST(list_cost AS DOUBLE) AS list_cost{tag_select} FROM {} {} ORDER BY ABS(cost) DESC LIMIT {row_limit}",
        ctx.source, ctx.where_sql
    );
    let conn = db::open()?;
    let tag_ids2 = tag_ids.clone();
    let rows = db::query_map(&conn, &sql, &ctx.params, move |r| {
        let mut tags = Map::new();
        for (i, id) in tag_ids2.iter().enumerate() {
            tags.insert(id.clone(), json!(str_at(r, 15 + i)));
        }
        json!({
            "date": str_at(r, 0), "hour": str_at(r, 1), "accountId": str_at(r, 2), "accountName": str_at(r, 3),
            "region": str_at(r, 4), "service": str_at(r, 5), "serviceFamily": str_at(r, 6), "lineItemType": str_at(r, 7),
            "operation": str_at(r, 8), "usageType": str_at(r, 9), "description": str_at(r, 10), "resourceId": str_at(r, 11),
            "usageAmount": f64_at(r, 12), "cost": f64_at(r, 13), "listCost": f64_at(r, 14), "tags": tags,
        })
    })?;
    Ok(json!({ "sampleRows": rows, "tagColumns": ctx.tag_columns }))
}

#[tauri::command(async)]
pub fn query_aggregated_table(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let ctx = explorer_ctx(&o, &state)?;
    if ctx.empty {
        return Ok(json!({ "rows": [], "totalRows": 0, "tagColumns": ctx.tag_columns }));
    }
    let row_limit = o.get("rowLimit").and_then(|v| v.as_i64()).unwrap_or(500).clamp(1, 1000);
    let tag_ids: Vec<String> = ctx.rc.dims.tags.iter().map(|t| query::tag_dim_column(t)).collect();
    let requested: Vec<String> = o.get("groupByColumns").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let group_cols: Vec<String> = requested.into_iter().filter(|c| query::SOURCE_COLUMNS.contains(&c.as_str()) || tag_ids.contains(c)).collect();
    let conn = db::open()?;
    if group_cols.is_empty() {
        let sql = format!("SELECT CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(list_cost) AS DOUBLE) AS list_cost, CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount, CAST(COUNT(*) AS DOUBLE) AS row_count FROM {} {}", ctx.source, ctx.where_sql);
        let rows = db::query_map(&conn, &sql, &ctx.params, |r| json!({ "values": {}, "cost": f64_at(r, 0), "listCost": f64_at(r, 1), "usageAmount": f64_at(r, 2), "rowCount": f64_at(r, 3) }))?;
        let total = if rows.is_empty() { 0 } else { 1 };
        return Ok(json!({ "rows": rows, "totalRows": total, "tagColumns": ctx.tag_columns }));
    }
    let select_cols: Vec<String> = group_cols.iter().map(|c| if c == "usage_date" { "usage_date::VARCHAR AS usage_date".to_string() } else { c.clone() }).collect();
    let group_join = group_cols.join(", ");
    let data_sql = format!("SELECT {}, CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(list_cost) AS DOUBLE) AS list_cost, CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount, CAST(COUNT(*) AS DOUBLE) AS row_count FROM {} {} GROUP BY {} ORDER BY SUM(cost) DESC LIMIT {row_limit}", select_cols.join(", "), ctx.source, ctx.where_sql, group_join);
    let count_sql = format!("SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM (SELECT 1 FROM {} {} GROUP BY {}) _c", ctx.source, ctx.where_sql, group_join);
    let gc = group_cols.clone();
    let n_data = group_cols.len();
    let data = db::query_map(&conn, &data_sql, &ctx.params, move |r| {
        let mut values = Map::new();
        for (i, col) in gc.iter().enumerate() {
            values.insert(col.clone(), json!(str_at(r, i)));
        }
        json!({ "values": values, "cost": f64_at(r, n_data), "listCost": f64_at(r, n_data + 1), "usageAmount": f64_at(r, n_data + 2), "rowCount": f64_at(r, n_data + 3) })
    })?;
    let total_rows = db::query_map(&conn, &count_sql, &ctx.params, |r| f64_at(r, 0))?.first().copied().unwrap_or(0.0);
    Ok(json!({ "rows": data, "totalRows": total_rows, "tagColumns": ctx.tag_columns }))
}

#[tauri::command(async)]
pub fn get_explorer_filter_values(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let dim_id = pstr(&o, "dimensionId").ok_or("get_explorer_filter_values: missing dimensionId")?;
    let mut o2 = o.clone();
    if let Some(filters) = o2.get("filters").and_then(|v| v.as_object()).cloned() {
        let pruned: Map<String, J> = filters.into_iter().filter(|(k, _)| k != dim_id).collect();
        o2.insert("filters".into(), J::Object(pruned));
    }
    let ctx = explorer_ctx(&o2, &state)?;
    if ctx.empty {
        return Ok(json!([]));
    }
    let field_expr = query::resolve_field_or_column(dim_id, &ctx.rc.dims).ok_or_else(|| format!("unknown dimension {dim_id:?}"))?;
    let sql = format!("SELECT {field_expr} AS val, CAST(COALESCE(SUM(cost),0) AS DOUBLE) AS total_cost, CAST(COUNT(*) AS DOUBLE) AS row_count FROM {} {} GROUP BY val HAVING val IS NOT NULL AND val != '' ORDER BY total_cost DESC LIMIT 500", ctx.source, ctx.where_sql);
    let conn = db::open()?;
    let is_acct = ctx.rc.is_account_group(dim_id);
    if is_acct {
        let raw = db::query_map(&conn, &sql, &ctx.params, |r| (str_at(r, 0), f64_at(r, 1), f64_at(r, 2)))?;
        let mut merged: HashMap<String, (f64, f64)> = HashMap::new();
        let mut order: Vec<String> = vec![];
        for (id, cost, rc) in raw {
            let name = ctx.rc.map_account(&id);
            if !merged.contains_key(&name) { order.push(name.clone()); }
            let e = merged.entry(name).or_insert((0.0, 0.0));
            e.0 += cost; e.1 += rc;
        }
        order.sort_by(|a, b| merged[b].0.partial_cmp(&merged[a].0).unwrap_or(std::cmp::Ordering::Equal));
        let out: Vec<J> = order.into_iter().map(|n| { let (c, rc) = merged[&n]; json!({ "value": n, "label": n, "cost": c, "rows": rc }) }).collect();
        return Ok(J::Array(out));
    }
    let rows = db::query_map(&conn, &sql, &ctx.params, |r| json!({ "value": str_at(r, 0), "label": str_at(r, 0), "cost": f64_at(r, 1), "rows": f64_at(r, 2) }))?;
    Ok(J::Array(rows))
}

// --- missing tags ---

const PLACEHOLDER_PATTERNS: &[&str] = &["unknown-%", "unknown_%", "unassigned-%", "unassigned_%", "none", "n/a", "tbd"];

#[tauri::command(async)]
pub fn query_missing_tags(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let tag_dim = pstr(&o, "tagDimension").ok_or("query_missing_tags: missing tagDimension")?;
    let (start, end) = date_range(&o).ok_or("query_missing_tags: missing dateRange")?;
    let min_cost = o.get("minCost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ctx = req_ctx(&state)?;
    let periods = available_periods(&state.data_dir, "daily", &start, &end);
    let empty = json!({ "rows": [], "totalRows": 0, "totalActionableCost": 0.0, "totalLikelyUntaggableCost": 0.0, "totalNonResourceCost": 0.0, "actionableCount": 0, "likelyUntaggableCount": 0, "unfilteredActionableCount": 0, "unfilteredActionableCost": 0.0, "unfilteredLikelyUntaggableCount": 0, "unfilteredLikelyUntaggableCost": 0.0, "nonResourceRows": [] });
    if periods.is_empty() || !query::valid_date(&start) || !query::valid_date(&end) {
        return Ok(empty);
    }
    let resolved = query::resolve_field(tag_dim, &ctx.dims).ok_or_else(|| format!("unknown dimension {tag_dim:?}"))?;
    let tag_field = resolved.raw_field;
    let source = ctx.source(&state.data_dir, "daily", &periods, &ctx.metric, ctx.net);
    let excl = if ctx.exclusions.is_empty() { String::new() } else { format!("\n    AND {}", ctx.exclusions.join(" AND ")) };

    let mut tagged = vec![format!("{tag_field} IS NOT NULL"), format!("{tag_field} != ''")];
    for p in PLACEHOLDER_PATTERNS {
        tagged.push(format!("{tag_field} NOT ILIKE '{}'", query::sql_escape(p)));
    }
    let is_tagged = tagged.join(" AND ");
    let resources_sql = format!(
        "WITH resources AS (\n  SELECT account_id, account_name, service, service_family, resource_id,\n    SUM(cost) AS cost,\n    MAX(CASE WHEN {is_tagged} THEN 1 ELSE 0 END) AS has_tag,\n    MAX({tag_field}) AS closest_owner\n  FROM {source}\n  WHERE usage_date BETWEEN '{start}' AND '{end}'\n    AND line_item_type IN ('Usage', 'DiscountedUsage')\n    AND resource_id IS NOT NULL AND resource_id != ''{excl}\n  GROUP BY account_id, account_name, service, service_family, resource_id\n),\ncategory_coverage AS (\n  SELECT service, service_family,\n    CASE WHEN SUM(cost) > 0 THEN SUM(CASE WHEN has_tag = 1 THEN cost ELSE 0 END) / SUM(cost) ELSE 0 END AS tagged_ratio\n  FROM resources GROUP BY service, service_family\n)\nSELECT r.account_id, r.account_name, r.resource_id, r.service, r.service_family, CAST(r.cost AS DOUBLE) AS cost, r.closest_owner, CAST(c.tagged_ratio AS DOUBLE) AS tagged_ratio,\n  CASE WHEN c.tagged_ratio > 0 THEN 'actionable' ELSE 'likely-untaggable' END AS bucket\nFROM resources r JOIN category_coverage c USING (service, service_family)\nWHERE r.has_tag = 0\nORDER BY r.cost DESC"
    );
    let non_resource_sql = format!(
        "SELECT service, service_family, line_item_type, CAST(SUM(cost) AS DOUBLE) AS cost\nFROM {source}\nWHERE usage_date BETWEEN '{start}' AND '{end}'\n  AND (line_item_type NOT IN ('Usage', 'DiscountedUsage') OR resource_id IS NULL OR resource_id = ''){excl}\nGROUP BY service, service_family, line_item_type\nHAVING SUM(cost) > 0\nORDER BY cost DESC"
    );
    let conn = db::open()?;
    struct Res { account_id: String, account_name: String, resource_id: String, service: String, service_family: String, cost: f64, closest_owner: String, tagged_ratio: f64, bucket: String }
    let resources = db::query_map(&conn, &resources_sql, &[], |r| Res {
        account_id: str_at(r, 0), account_name: str_at(r, 1), resource_id: str_at(r, 2), service: str_at(r, 3),
        service_family: str_at(r, 4), cost: f64_at(r, 5), closest_owner: str_at(r, 6), tagged_ratio: f64_at(r, 7), bucket: str_at(r, 8),
    })?;
    let (mut ua_cost, mut uu_cost, mut ua_n, mut uu_n) = (0.0, 0.0, 0i64, 0i64);
    for r in &resources {
        if r.bucket == "actionable" { ua_cost += r.cost; ua_n += 1; } else { uu_cost += r.cost; uu_n += 1; }
    }
    let filtered: Vec<&Res> = resources.iter().filter(|r| min_cost <= 0.0 || r.cost >= min_cost).collect();
    let (mut a_cost, mut u_cost, mut a_n, mut u_n) = (0.0, 0.0, 0i64, 0i64);
    for r in &filtered {
        if r.bucket == "actionable" { a_cost += r.cost; a_n += 1; } else { u_cost += r.cost; u_n += 1; }
    }
    let rows: Vec<J> = filtered.iter().take(5000).map(|r| json!({
        "accountId": r.account_id, "accountName": ctx.map_account(&r.account_id), "resourceId": r.resource_id,
        "service": r.service, "serviceFamily": r.service_family, "cost": r.cost,
        "closestOwner": if r.closest_owner.is_empty() { J::Null } else { json!(r.closest_owner) },
        "bucket": r.bucket, "categoryTaggedRatio": r.tagged_ratio,
    })).collect();
    let mut nr_cost = 0.0;
    let nr = db::query_map(&conn, &non_resource_sql, &[], |r| (str_at(r, 0), str_at(r, 1), str_at(r, 2), f64_at(r, 3)))?;
    let nr_rows: Vec<J> = nr.into_iter().map(|(s, f, l, c)| { nr_cost += c; json!({ "service": s, "serviceFamily": f, "lineItemType": l, "cost": c }) }).collect();
    Ok(json!({
        "rows": rows, "totalRows": filtered.len(), "totalActionableCost": a_cost, "totalLikelyUntaggableCost": u_cost,
        "totalNonResourceCost": nr_cost, "actionableCount": a_n, "likelyUntaggableCount": u_n,
        "unfilteredActionableCount": ua_n, "unfilteredActionableCost": ua_cost,
        "unfilteredLikelyUntaggableCount": uu_n, "unfilteredLikelyUntaggableCost": uu_cost, "nonResourceRows": nr_rows,
    }))
}

// --- dimensions discovery ---

#[tauri::command(async)]
pub fn discover_tag_keys(state: tauri::State<AppState>) -> R {
    let months = list_local_months(&state.data_dir, "daily");
    let sample = months.last().cloned().unwrap_or_default();
    if sample.is_empty() {
        return Ok(json!({ "tags": [], "samplePeriod": "" }));
    }
    let glob = format!("'{}/aws/raw/daily-{}/*.parquet'", query::sql_escape(&state.data_dir), sample);
    let sql = format!(
        "WITH kv AS (SELECT unnest(map_keys(resource_tags)) AS k, unnest(map_values(resource_tags)) AS v FROM read_parquet({glob})), total AS (SELECT COUNT(*) AS n FROM read_parquet({glob})) SELECT k, CAST(COUNT(*) AS DOUBLE) AS rows, CAST(COUNT(DISTINCT v) AS DOUBLE) AS distinct_count, (SELECT n FROM total) AS total_rows, string_agg(DISTINCT v, '||') AS samples FROM kv GROUP BY k ORDER BY rows DESC"
    );
    let conn = db::open()?;
    let rows = db::query_map(&conn, &sql, &[], |r| {
        let key = str_at(r, 0);
        let rows_n = f64_at(r, 1);
        let total = f64_at(r, 3);
        let samples = str_at(r, 4);
        let sample_values: Vec<String> = samples.split("||").filter(|s| !s.is_empty()).take(5).map(|s| s.to_string()).collect();
        let display = key.strip_prefix("user_").unwrap_or(&key).to_string();
        json!({ "key": display, "sampleValues": sample_values, "rowCount": rows_n, "distinctCount": f64_at(r, 2), "coveragePct": if total > 0.0 { rows_n / total * 100.0 } else { 0.0 } })
    })?;
    Ok(json!({ "tags": rows, "samplePeriod": sample }))
}

#[tauri::command(async)]
pub fn discover_column_values(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let field = pstr(&o, "field").ok_or("discover_column_values: missing field")?;
    let ctx = req_ctx(&state)?;
    let months = list_local_months(&state.data_dir, "daily");
    let sample = months.last().cloned().unwrap_or_default();
    if sample.is_empty() {
        return Ok(json!({ "values": [], "distinctCount": 0, "period": "" }));
    }
    let source = ctx.source(&state.data_dir, "daily", std::slice::from_ref(&sample), &ctx.metric, ctx.net);
    let field_expr = query::resolve_field_or_column(field, &ctx.dims).unwrap_or_else(|| field.to_string());
    let sql = format!("SELECT {field_expr} AS val, CAST(SUM(cost) AS DOUBLE) AS cost FROM {source} GROUP BY val HAVING val IS NOT NULL AND val != '' ORDER BY cost DESC LIMIT 1000");
    let conn = db::open()?;
    let rows = db::query_map(&conn, &sql, &[], |r| json!({ "value": str_at(r, 0), "cost": f64_at(r, 1) }))?;
    let count = rows.len();
    Ok(json!({ "values": rows, "distinctCount": count, "period": sample }))
}

// --- savings / cost-optimization recommendations (local read) ---

fn to_effort(v: &str) -> &'static str {
    match v {
        "VeryLow" => "VeryLow",
        "Low" => "Low",
        "High" => "High",
        _ => "Medium",
    }
}

#[tauri::command(async)]
pub fn query_savings(state: tauri::State<AppState>) -> R {
    let glob = format!("{}/aws/raw/cost-opt-*/*.parquet", query::sql_escape(&state.data_dir));
    let sql = format!(
        "SELECT account_id, account_name, action_type, current_resource_type, \
         COALESCE(recommended_resource_summary, '') AS summary, COALESCE(region, '') AS region, \
         CAST(COALESCE(estimated_monthly_savings_after_discount, 0) AS DOUBLE) AS monthly_savings, \
         CAST(COALESCE(estimated_monthly_cost_after_discount, 0) AS DOUBLE) AS monthly_cost, \
         CAST(COALESCE(estimated_savings_percentage_after_discount, 0) AS DOUBLE) AS savings_pct, \
         COALESCE(implementation_effort, '') AS effort, COALESCE(resource_arn, '') AS resource_arn, \
         COALESCE(current_resource_details, '') AS current_details, COALESCE(recommended_resource_details, '') AS recommended_details, \
         COALESCE(current_resource_summary, '') AS current_summary, COALESCE(restart_needed, false) AS restart_needed, \
         COALESCE(rollback_possible, false) AS rollback_possible, COALESCE(recommendation_source, '') AS recommendation_source \
         FROM read_parquet('{glob}', filename=true) \
         QUALIFY ROW_NUMBER() OVER (PARTITION BY recommendation_id ORDER BY filename DESC) = 1 \
         ORDER BY monthly_savings DESC"
    );
    let conn = db::open()?;
    let rows = match db::query_map(&conn, &sql, &[], |r| {
        let savings = f64_at(r, 6);
        (
            savings,
            json!({
                "accountId": str_at(r, 0), "accountName": str_at(r, 1), "actionType": str_at(r, 2),
                "resourceType": str_at(r, 3), "summary": str_at(r, 4), "region": str_at(r, 5),
                "monthlySavings": savings, "monthlyCost": f64_at(r, 7), "savingsPercentage": f64_at(r, 8),
                "effort": to_effort(&str_at(r, 9)), "resourceArn": str_at(r, 10), "currentDetails": str_at(r, 11),
                "recommendedDetails": str_at(r, 12), "currentSummary": str_at(r, 13), "restartNeeded": db::bool_at(r, 14),
                "rollbackPossible": db::bool_at(r, 15), "recommendationSource": str_at(r, 16),
            }),
        )
    }) {
        // No cost-opt files (glob matches nothing) → DuckDB errors → empty result.
        Ok(v) => v,
        Err(_) => return Ok(json!({ "recommendations": [], "totalMonthlySavings": 0.0 })),
    };
    let total: f64 = rows.iter().map(|(s, _)| *s).sum();
    let recs: Vec<J> = rows.into_iter().map(|(_, j)| j).collect();
    Ok(json!({ "recommendations": recs, "totalMonthlySavings": total }))
}

// --- config sharing (bundle export/import + S3 beacon) ---

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Build a bundle from the local config and save it via a native dialog.
#[tauri::command]
pub async fn export_config_bundle(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> R {
    let exported_at = now_iso();
    let yaml = match crate::bundle::build_bundle_yaml(&state.config_dir, &state.app_version, &exported_at) {
        Ok(y) => y,
        Err(e) => return Ok(json!({ "status": "error", "message": e })),
    };
    let default_name = format!("costgoblin-config-{}.yaml", &exported_at[..10]);
    let picked = app
        .dialog()
        .file()
        .add_filter("CostGoblin configuration bundle", &["yaml", "yml"])
        .set_file_name(&default_name)
        .blocking_save_file();
    let Some(fp) = picked else { return Ok(json!({ "status": "canceled" })) };
    let path = fp.as_path().map(|p| p.to_path_buf());
    let Some(path) = path else { return Ok(json!({ "status": "error", "message": "Unsupported save location" })) };
    match std::fs::write(&path, yaml) {
        Ok(()) => Ok(json!({ "status": "saved", "path": path.to_string_lossy() })),
        Err(e) => Ok(json!({ "status": "error", "message": format!("write {}: {e}", path.display()) })),
    }
}

/// Pick a bundle file, parse + summarize it for the import preview.
#[tauri::command]
pub async fn preview_config_bundle_file(app: tauri::AppHandle) -> R {
    let picked = app
        .dialog()
        .file()
        .add_filter("CostGoblin configuration bundle", &["yaml", "yml"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    let Some(fp) = picked else { return Ok(json!({ "status": "canceled" })) };
    let Some(path) = fp.as_path().map(|p| p.to_path_buf()) else { return Ok(json!({ "status": "error", "message": "Unsupported file location" })) };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => return Ok(json!({ "status": "error", "message": format!("read {}: {e}", path.display()) })),
    };
    match crate::bundle::parse_bundle(&content) {
        Ok(parsed) => Ok(json!({ "status": "ok", "content": content, "summary": crate::bundle::summarize(&parsed) })),
        Err(e) => Ok(json!({ "status": "error", "message": e })),
    }
}

/// Fetch a bundle from an explicit S3 location (every failure surfaced).
#[tauri::command]
pub async fn fetch_config_bundle_from_s3(params: J, _state: tauri::State<'_, AppState>) -> R {
    let o = pobj(&params);
    let profile = pstr(&o, "profile").unwrap_or("default").to_string();
    let location = pstr(&o, "location").unwrap_or("");
    let Some((bucket, key)) = crate::sharing::split_s3_location(location) else {
        return Ok(json!({ "status": "error", "message": "Invalid S3 location — expected s3://bucket/path/to/org-config.yaml" }));
    };
    let loc = format!("s3://{bucket}/{key}");
    match crate::sharing::s3_get(&bucket, &key, &profile).await {
        Ok(content) => match crate::bundle::parse_bundle(&content) {
            Ok(parsed) => Ok(json!({ "status": "ok", "content": content, "summary": crate::bundle::summarize(&parsed) })),
            Err(e) => Ok(json!({ "status": "error", "message": e })),
        },
        Err(e) if crate::sharing::is_beacon_absence(&e) => Ok(json!({ "status": "error", "message": format!("No bundle found at {loc} (missing object or access denied)") })),
        Err(e) => Ok(json!({ "status": "error", "message": e })),
    }
}

/// Re-parse + re-validate, back up existing config, materialize the bundle.
#[tauri::command(async)]
pub fn apply_config_bundle(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let content = pstr(&o, "content").unwrap_or("");
    let profile = pstr(&o, "profile").unwrap_or("");
    if profile.is_empty() {
        return Ok(json!({ "status": "error", "message": "Invalid import parameters" }));
    }
    let parsed = match crate::bundle::parse_bundle(content) {
        Ok(p) => p,
        Err(e) => return Ok(json!({ "status": "error", "message": e })),
    };
    let backup_dir = match crate::sharing::backup_config(&state.config_dir) {
        Ok(b) => b,
        Err(e) => return Ok(json!({ "status": "error", "message": e })),
    };
    match crate::bundle::materialize(&state.config_dir, &parsed.sections, profile) {
        Ok(sections) => Ok(json!({ "status": "applied", "sections": sections, "backupDir": backup_dir })),
        Err(e) => Ok(json!({ "status": "error", "message": e })),
    }
}

/// Publish the current bundle to S3 (default: beacon key at the daily bucket root).
#[tauri::command]
pub async fn publish_config_bundle(params: J, state: tauri::State<'_, AppState>) -> R {
    let (default_profile, sync) = match resolve_provider(state.inner()) {
        Ok(v) => v,
        Err(_) => return Ok(json!({ "status": "error", "message": "No provider configured — complete setup before publishing" })),
    };
    let o = pobj(&params);
    let requested = match pstr(&o, "location") {
        Some(l) if !l.trim().is_empty() => l.to_string(),
        _ => crate::sharing::suggested_beacon_location(sync.get("daily").and_then(|d| d.get("bucket")).and_then(|b| b.as_str()).unwrap_or("")),
    };
    let Some((bucket, key)) = crate::sharing::split_s3_location(&requested) else {
        return Ok(json!({ "status": "error", "message": "Invalid S3 location — expected s3://bucket/path/to/org-config.yaml" }));
    };
    let profile = match pstr(&o, "profile") {
        Some(p) if !p.trim().is_empty() => p.to_string(),
        _ => default_profile,
    };
    let yaml = match crate::bundle::build_bundle_yaml(&state.config_dir, &state.app_version, &now_iso()) {
        Ok(y) => y,
        Err(e) => return Ok(json!({ "status": "error", "message": e })),
    };
    match crate::sharing::s3_put(&bucket, &key, yaml, &profile).await {
        Ok(()) => Ok(json!({ "status": "published", "location": format!("s3://{bucket}/{key}") })),
        Err(e) => Ok(json!({ "status": "error", "message": e })),
    }
}

/// Probe the well-known beacon key at a bucket root (silent on absence).
#[tauri::command]
pub async fn check_config_beacon(params: J, _state: tauri::State<'_, AppState>) -> R {
    let o = pobj(&params);
    let profile = pstr(&o, "profile").unwrap_or("default").to_string();
    let bucket = pstr(&o, "bucket").unwrap_or("");
    if bucket.is_empty() {
        return Ok(json!({ "status": "error", "message": "Invalid beacon parameters" }));
    }
    let key = crate::bundle::CONFIG_BEACON_KEY;
    let location = format!("s3://{bucket}/{key}");
    match crate::sharing::s3_get(bucket, key, &profile).await {
        Ok(content) => match crate::bundle::parse_bundle(&content) {
            Ok(parsed) => Ok(json!({ "status": "found", "location": location, "content": content, "summary": crate::bundle::summarize(&parsed) })),
            // Something IS published but unusable — worth telling the user.
            Err(e) => Ok(json!({ "status": "error", "message": format!("Found {location} but it is not a valid bundle: {e}") })),
        },
        // Absence OR network/credential hiccup → never block manual setup.
        Err(_) => Ok(json!({ "status": "none" })),
    }
}

// --- rollup (pre-aggregated dashboard source) ---

#[tauri::command(async)]
pub fn get_rollup_status(state: tauri::State<AppState>) -> R {
    Ok(crate::rollup::status(&state.data_dir))
}
#[tauri::command(async)]
pub fn get_rollup_stats(state: tauri::State<AppState>) -> R {
    Ok(crate::rollup::stats(&state.data_dir))
}
#[tauri::command(async)]
pub fn estimate_rollup_grain(params: J, state: tauri::State<AppState>) -> R {
    // params IS the candidate DimensionsConfig.
    Ok(crate::rollup::estimate_grain(&state.data_dir, &params))
}

// --- MCP server (AI Assistant) ---

#[tauri::command(async)]
pub fn get_mcp_server_running() -> Result<bool, String> {
    Ok(crate::mcp::is_running())
}

#[tauri::command(async)]
pub fn set_mcp_server_running(params: J, state: tauri::State<AppState>) -> Result<(), String> {
    let enabled = params.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    if enabled {
        crate::mcp::start(state.data_dir.clone(), state.config_dir.clone())
    } else {
        crate::mcp::stop();
        Ok(())
    }
}

#[tauri::command(async)]
pub fn get_mcp_token(state: tauri::State<AppState>) -> Result<String, String> {
    Ok(crate::mcp::get_token(&state.data_dir))
}

#[tauri::command(async)]
pub fn regenerate_mcp_token(state: tauri::State<AppState>) -> Result<String, String> {
    Ok(crate::mcp::regenerate_token(&state.data_dir))
}
