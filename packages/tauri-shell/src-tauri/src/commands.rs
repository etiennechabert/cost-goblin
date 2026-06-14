//! Tauri commands implementing the read half of CostApi over the fixture
//! Parquet. Each returns serde_json::Value shaped exactly like the TS handlers.

use crate::config::{self, Dimensions};
use crate::db::{self, f64_at, str_at};
use crate::query::{self, available_periods, build_source, list_local_months};
use serde_json::{json, Map, Value as J};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct AppState {
    pub data_dir: String,
    pub config_dir: PathBuf,
    pub app_version: String,
}

type R = Result<J, String>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn pobj(params: &J) -> Map<String, J> {
    params.as_object().cloned().unwrap_or_default()
}

fn pstr<'a>(o: &'a Map<String, J>, key: &str) -> Option<&'a str> {
    o.get(key).and_then(|v| v.as_str())
}

fn date_range(o: &Map<String, J>) -> Option<(String, String)> {
    let dr = o.get("dateRange")?.as_object()?;
    let start = dr.get("start")?.as_str()?.to_string();
    let end = dr.get("end")?.as_str()?.to_string();
    Some((start, end))
}

fn filters_map(o: &Map<String, J>) -> Map<String, J> {
    o.get("filters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn tier_of(o: &Map<String, J>) -> &'static str {
    if pstr(o, "granularity") == Some("hourly") {
        "hourly"
    } else {
        "daily"
    }
}

fn metric_of(o: &Map<String, J>) -> &'static str {
    if pstr(o, "costMetric") == Some("list") {
        "list"
    } else {
        "unblended"
    }
}

fn load_dims(state: &AppState) -> Result<Dimensions, String> {
    config::load_dimensions(&state.config_dir)
}

// ---------------------------------------------------------------------------
// config reads
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_version(state: tauri::State<AppState>) -> Result<String, String> {
    Ok(state.app_version.clone())
}

#[tauri::command]
pub fn get_config(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("costgoblin.yaml"))
}

#[tauri::command]
pub fn get_dimensions(state: tauri::State<AppState>) -> R {
    let dims = load_dims(&state)?;
    Ok(config::dimensions_flat(&dims))
}

#[tauri::command]
pub fn get_dimensions_config(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("dimensions.yaml"))
}

#[tauri::command]
pub fn get_org_tree(state: tauri::State<AppState>) -> R {
    let v = config::load_yaml_json(&state.config_dir.join("org-tree.yaml"))?;
    Ok(v.get("tree").cloned().unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub fn get_views_config(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("views.yaml"))
}

#[tauri::command]
pub fn get_cost_scope(state: tauri::State<AppState>) -> R {
    config::load_yaml_json(&state.config_dir.join("cost-scope.yaml"))
}

#[tauri::command]
pub fn get_ui_preferences() -> R {
    Ok(json!({ "theme": "dark", "palette": "standard" }))
}

#[tauri::command]
pub fn get_explorer_preferences() -> R {
    // Omit lastUsedDateRange so the Explorer uses its own now-based default,
    // which lands on the (date-shifted) fixture window.
    Ok(json!({ "hiddenColumns": [], "columnOrder": [] }))
}

#[tauri::command]
pub fn get_data_inventory(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let tier = pstr(&o, "tier").unwrap_or("daily");
    let months = list_local_months(&state.data_dir, tier);
    let mut periods = vec![];
    let mut disk_bytes: u64 = 0;
    for m in &months {
        let dir = PathBuf::from(&state.data_dir)
            .join("aws")
            .join("raw")
            .join(format!("{tier}-{m}"));
        let mut total: u64 = 0;
        let mut files = vec![];
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("parquet") {
                    let size = std::fs::metadata(&p).map(|md| md.len()).unwrap_or(0);
                    total += size;
                    files.push(json!({
                        "key": p.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                        "contentHash": "",
                        "size": size,
                    }));
                }
            }
        }
        disk_bytes += total;
        periods.push(json!({
            "period": m,
            "files": files,
            "totalSize": total,
            "localStatus": "repartitioned",
        }));
    }
    Ok(json!({
        "periods": periods,
        "totalRemoteSize": disk_bytes,
        "totalLocalPeriods": months.len(),
        "totalRemotePeriods": months.len(),
        "local": {
            "periods": months,
            "diskBytes": disk_bytes,
            "oldestPeriod": months.first().cloned().map(J::String).unwrap_or(J::Null),
            "newestPeriod": months.last().cloned().map(J::String).unwrap_or(J::Null),
        }
    }))
}

// ---------------------------------------------------------------------------
// cost queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn query_costs(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let group_by = pstr(&o, "groupBy").ok_or("query_costs: missing groupBy")?;
    let (start, end) = date_range(&o).ok_or("query_costs: missing dateRange")?;
    let dims = load_dims(&state)?;
    let tier = tier_of(&o);
    let periods = available_periods(&state.data_dir, tier, &start, &end);
    if periods.is_empty() {
        return Ok(json!({ "rows": [], "totalCost": 0.0, "topServices": [],
            "dateRange": o.get("dateRange").cloned().unwrap_or(J::Null) }));
    }
    let source = build_source(&state.data_dir, tier, &periods, "unblended", &dims);
    let built = query::cost_query(group_by, &start, &end, &filters_map(&o), &dims, &source)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| {
        (str_at(row, 0), f64_at(row, 1), str_at(row, 2), f64_at(row, 3))
    })?;

    let mut order: Vec<String> = vec![];
    let mut totals: HashMap<String, f64> = HashMap::new();
    let mut services: HashMap<String, Map<String, J>> = HashMap::new();
    let mut service_totals: HashMap<String, f64> = HashMap::new();
    for (entity, total, service, scost) in rows {
        if !totals.contains_key(&entity) {
            order.push(entity.clone());
            totals.insert(entity.clone(), total);
            services.insert(entity.clone(), Map::new());
        }
        if !service.is_empty() {
            services
                .get_mut(&entity)
                .map(|m| m.insert(service.clone(), json!(scost)));
            *service_totals.entry(service).or_insert(0.0) += scost;
        }
    }
    let total_cost: f64 = order.iter().map(|e| *totals.get(e).unwrap_or(&0.0)).sum();
    let mut svc_sorted: Vec<(String, f64)> = service_totals.into_iter().collect();
    svc_sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top_services: Vec<J> = svc_sorted.iter().take(5).map(|(s, _)| json!(s)).collect();

    let cost_rows: Vec<J> = order
        .iter()
        .map(|e| {
            json!({
                "entity": e,
                "totalCost": totals.get(e).copied().unwrap_or(0.0),
                "serviceCosts": services.get(e).cloned().unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({
        "rows": cost_rows,
        "totalCost": total_cost,
        "topServices": top_services,
        "dateRange": o.get("dateRange").cloned().unwrap_or(J::Null),
    }))
}

#[tauri::command]
pub fn query_daily_costs(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let group_by = pstr(&o, "groupBy").ok_or("query_daily_costs: missing groupBy")?;
    let (start, end) = date_range(&o).ok_or("query_daily_costs: missing dateRange")?;
    let dims = load_dims(&state)?;
    let tier = tier_of(&o);
    let periods = available_periods(&state.data_dir, tier, &start, &end);
    if periods.is_empty() {
        return Ok(json!({ "days": [], "groups": [], "totalCost": 0.0 }));
    }
    let source = build_source(&state.data_dir, tier, &periods, "unblended", &dims);
    let built = query::daily_costs_query(group_by, &start, &end, &filters_map(&o), &dims, &source)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| {
        (str_at(row, 0), str_at(row, 1), f64_at(row, 2))
    })?;

    let mut day_order: Vec<String> = vec![];
    let mut days: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut group_totals: HashMap<String, f64> = HashMap::new();
    let mut total_cost = 0.0;
    for (date, group, cost) in rows {
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
            let bmap: Map<String, J> =
                breakdown.into_iter().map(|(k, v)| (k, json!(v))).collect();
            json!({ "date": d, "total": total, "breakdown": bmap })
        })
        .collect();
    let mut groups: Vec<(String, f64)> = group_totals.into_iter().collect();
    groups.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let group_names: Vec<J> = groups.into_iter().map(|(g, _)| json!(g)).collect();
    Ok(json!({ "days": day_rows, "groups": group_names, "totalCost": total_cost }))
}

#[tauri::command]
pub fn query_trends(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let group_by = pstr(&o, "groupBy").ok_or("query_trends: missing groupBy")?;
    let (start, end) = date_range(&o).ok_or("query_trends: missing dateRange")?;
    let delta_threshold = o.get("deltaThreshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let percent_threshold = o.get("percentThreshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let dims = load_dims(&state)?;
    let periods = query::trend_periods(&state.data_dir, &start, &end);
    if periods.is_empty() {
        return Ok(json!({ "increases": [], "savings": [], "totalIncrease": 0.0, "totalSavings": 0.0 }));
    }
    let source = build_source(&state.data_dir, "daily", &periods, "unblended", &dims);
    let built = query::trend_query(group_by, &start, &end, delta_threshold, &filters_map(&o), &dims, &source)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| {
        (str_at(row, 0), f64_at(row, 1), f64_at(row, 2), f64_at(row, 3), f64_at(row, 4))
    })?;
    let mut increases = vec![];
    let mut savings = vec![];
    let mut total_increase = 0.0;
    let mut total_savings = 0.0;
    for (entity, current, previous, delta, percent) in rows {
        if delta.abs() < delta_threshold {
            continue;
        }
        if percent.abs() < percent_threshold {
            continue;
        }
        let row = json!({
            "entity": entity,
            "currentCost": current,
            "previousCost": previous,
            "delta": delta,
            "percentChange": percent,
        });
        if delta > 0.0 {
            total_increase += delta;
            increases.push(row);
        } else {
            total_savings += delta.abs();
            savings.push(row);
        }
    }
    Ok(json!({
        "increases": increases,
        "savings": savings,
        "totalIncrease": total_increase,
        "totalSavings": total_savings,
    }))
}

#[tauri::command]
pub fn query_entity_detail(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let dimension = pstr(&o, "dimension").ok_or("query_entity_detail: missing dimension")?;
    let entity = pstr(&o, "entity").ok_or("query_entity_detail: missing entity")?;
    let (start, end) = date_range(&o).ok_or("query_entity_detail: missing dateRange")?;
    let dims = load_dims(&state)?;
    let periods = available_periods(&state.data_dir, "daily", &start, &end);
    let empty = json!({
        "entity": entity, "totalCost": 0.0, "previousCost": 0.0, "percentChange": 0.0,
        "dailyCosts": [], "byAccount": [], "byService": [], "bySubEntity": []
    });
    if periods.is_empty() {
        return Ok(empty);
    }
    let source = build_source(&state.data_dir, "daily", &periods, "unblended", &dims);
    let built = query::entity_detail_query(dimension, entity, &start, &end, &filters_map(&o), &dims, &source)?;
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
        if !day_cost.contains_key(&date) {
            day_order.push(date.clone());
            day_cost.insert(date.clone(), 0.0);
            day_svc.insert(date.clone(), HashMap::new());
            day_acct.insert(date.clone(), HashMap::new());
        }
        *day_cost.get_mut(&date).unwrap() += cost;
        *day_svc.get_mut(&date).unwrap().entry(service.clone()).or_insert(0.0) += cost;
        *day_acct.get_mut(&date).unwrap().entry(account_id.clone()).or_insert(0.0) += cost;
        *by_account.entry(account_id).or_insert(0.0) += cost;
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
        v.into_iter()
            .map(|(name, cost)| json!({ "name": name, "cost": cost, "percentage": if total > 0.0 { cost / total * 100.0 } else { 0.0 } }))
            .collect()
    };
    Ok(json!({
        "entity": entity, "totalCost": total, "previousCost": 0.0, "percentChange": 0.0,
        "dailyCosts": daily_costs,
        "byAccount": to_slices(by_account),
        "byService": to_slices(by_service),
        "bySubEntity": [],
    }))
}

#[tauri::command]
pub fn get_filter_values(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let dim_id = pstr(&o, "dimensionId").ok_or("get_filter_values: missing dimensionId")?;
    let dims = load_dims(&state)?;
    let (start, end) = match o.get("dateRange").and_then(|v| v.as_object()) {
        Some(dr) => (
            dr.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            dr.get("end").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        None => (String::new(), String::new()),
    };
    let has_range = query::valid_date(&start) && query::valid_date(&end);
    let periods = if has_range {
        available_periods(&state.data_dir, "daily", &start, &end)
    } else {
        list_local_months(&state.data_dir, "daily")
    };
    if periods.is_empty() {
        return Ok(json!([]));
    }
    let source = build_source(&state.data_dir, "daily", &periods, "unblended", &dims);
    let built = query::filter_values_query(dim_id, &start, &end, &filters_map(&o), &dims, &source)?;
    let conn = db::open()?;
    let rows = db::query_map(&conn, &built.sql, &built.params, |row| (str_at(row, 0), f64_at(row, 1)))?;
    let out: Vec<J> = rows
        .into_iter()
        .map(|(val, cost)| json!({ "value": val, "label": val, "count": cost }))
        .collect();
    Ok(J::Array(out))
}

// ---------------------------------------------------------------------------
// explorer
// ---------------------------------------------------------------------------

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
    dims: Dimensions,
}

fn explorer_ctx(o: &Map<String, J>, state: &AppState) -> Result<ExplorerCtx, String> {
    let dims = load_dims(state)?;
    let (start, end) = match date_range(o) {
        Some((s, e)) if query::valid_date(&s) && query::valid_date(&e) => (s, e),
        _ => {
            let now = query::epoch_days_now();
            let end = query::days_to_date(now - 2);
            let start = query::days_to_date(now - 2 - 29);
            (start, end)
        }
    };
    let tier = tier_of(o);
    let metric = metric_of(o);
    let window_days = query::window_days(&start, &end).max(1);
    let tag_columns: Vec<J> = dims
        .tags
        .iter()
        .map(|t| json!({ "id": query::tag_dim_column(t), "label": t.label }))
        .collect();
    let periods = available_periods(&state.data_dir, tier, &start, &end);
    if periods.is_empty() {
        return Ok(ExplorerCtx {
            empty: true,
            source: String::new(),
            where_sql: String::new(),
            params: vec![],
            tier,
            start,
            end,
            window_days,
            tag_columns,
            dims,
        });
    }
    let source = build_source(&state.data_dir, tier, &periods, metric, &dims);
    let mut qb = db::Qb::new();
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'")];
    wheres.extend(query::filter_clauses(&filters_map(o), &dims, &mut qb));
    let where_sql = format!("WHERE {}", wheres.join(" AND "));
    Ok(ExplorerCtx {
        empty: false,
        source,
        where_sql,
        params: qb.params,
        tier,
        start,
        end,
        window_days,
        tag_columns,
        dims,
    })
}

#[tauri::command]
pub fn query_explorer_overview(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let ctx = explorer_ctx(&o, &state)?;
    let zero = json!({
        "windowDays": ctx.window_days, "startDate": ctx.start, "endDate": ctx.end,
        "dailyTotals": [], "totalRows": 0, "totalCost": 0.0, "tagColumns": ctx.tag_columns,
    });
    if ctx.empty {
        return Ok(zero);
    }
    let conn = db::open()?;
    let bucket = if ctx.tier == "hourly" {
        "date_trunc('hour', usage_hour + INTERVAL '30 minutes')"
    } else {
        "usage_date"
    };
    let totals_sql = format!(
        "SELECT CAST(COALESCE(SUM(cost),0) AS DOUBLE) AS total_cost, CAST(COUNT(*) AS DOUBLE) AS total_rows FROM {} {}",
        ctx.source, ctx.where_sql
    );
    let daily_sql = format!(
        "SELECT {bucket}::VARCHAR AS date, CAST(COALESCE(SUM(cost),0) AS DOUBLE) AS daily_cost, CAST(COUNT(*) AS DOUBLE) AS daily_rows FROM {} {} GROUP BY {bucket} ORDER BY {bucket}",
        ctx.source, ctx.where_sql
    );
    let totals = db::query_map(&conn, &totals_sql, &ctx.params, |r| (f64_at(r, 0), f64_at(r, 1)))?;
    let (total_cost, total_rows) = totals.first().copied().unwrap_or((0.0, 0.0));
    let daily = db::query_map(&conn, &daily_sql, &ctx.params, |r| {
        json!({ "date": str_at(r, 0), "cost": f64_at(r, 1), "rows": f64_at(r, 2) })
    })?;
    Ok(json!({
        "windowDays": ctx.window_days, "startDate": ctx.start, "endDate": ctx.end,
        "dailyTotals": daily, "totalRows": total_rows, "totalCost": total_cost,
        "tagColumns": ctx.tag_columns,
    }))
}

#[tauri::command]
pub fn query_explorer_rows(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let ctx = explorer_ctx(&o, &state)?;
    if ctx.empty {
        return Ok(json!({ "sampleRows": [], "tagColumns": ctx.tag_columns }));
    }
    let row_limit = o.get("rowLimit").and_then(|v| v.as_i64()).unwrap_or(500).clamp(1, 1000);
    let tag_ids: Vec<String> = ctx
        .dims
        .tags
        .iter()
        .map(|t| query::tag_dim_column(t))
        .collect();
    let tag_select = if tag_ids.is_empty() {
        String::new()
    } else {
        format!(
            ",\n        {}",
            tag_ids.iter().map(|id| format!("COALESCE({id}, '') AS {id}")).collect::<Vec<_>>().join(",\n        ")
        )
    };
    let hour_select = if ctx.tier == "hourly" {
        "usage_hour::VARCHAR AS usage_hour"
    } else {
        "'' AS usage_hour"
    };
    let sql = format!(
        "SELECT usage_date::VARCHAR AS usage_date, {hour_select}, account_id, account_name, region, service, service_family, line_item_type, operation, usage_type, description, resource_id, CAST(usage_amount AS DOUBLE) AS usage_amount, CAST(cost AS DOUBLE) AS cost, CAST(list_cost AS DOUBLE) AS list_cost{tag_select} FROM {} {} ORDER BY ABS(cost) DESC LIMIT {row_limit}",
        ctx.source, ctx.where_sql
    );
    let conn = db::open()?;
    let tag_ids2 = tag_ids.clone();
    let rows = db::query_map(&conn, &sql, &ctx.params, move |r| {
        let mut tags = Map::new();
        // tag columns start at index 15
        for (i, id) in tag_ids2.iter().enumerate() {
            tags.insert(id.clone(), json!(str_at(r, 15 + i)));
        }
        json!({
            "date": str_at(r, 0), "hour": str_at(r, 1), "accountId": str_at(r, 2),
            "accountName": str_at(r, 3), "region": str_at(r, 4), "service": str_at(r, 5),
            "serviceFamily": str_at(r, 6), "lineItemType": str_at(r, 7), "operation": str_at(r, 8),
            "usageType": str_at(r, 9), "description": str_at(r, 10), "resourceId": str_at(r, 11),
            "usageAmount": f64_at(r, 12), "cost": f64_at(r, 13), "listCost": f64_at(r, 14),
            "tags": tags,
        })
    })?;
    Ok(json!({ "sampleRows": rows, "tagColumns": ctx.tag_columns }))
}

#[tauri::command]
pub fn query_aggregated_table(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let ctx = explorer_ctx(&o, &state)?;
    if ctx.empty {
        return Ok(json!({ "rows": [], "totalRows": 0, "tagColumns": ctx.tag_columns }));
    }
    let row_limit = o.get("rowLimit").and_then(|v| v.as_i64()).unwrap_or(500).clamp(1, 1000);
    let tag_ids: Vec<String> = ctx.dims.tags.iter().map(|t| query::tag_dim_column(t)).collect();
    let requested: Vec<String> = o
        .get("groupByColumns")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let group_cols: Vec<String> = requested
        .into_iter()
        .filter(|c| query::SOURCE_COLUMNS.contains(&c.as_str()) || tag_ids.contains(c))
        .collect();
    let conn = db::open()?;
    if group_cols.is_empty() {
        let sql = format!(
            "SELECT CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(list_cost) AS DOUBLE) AS list_cost, CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount, CAST(COUNT(*) AS DOUBLE) AS row_count FROM {} {}",
            ctx.source, ctx.where_sql
        );
        let rows = db::query_map(&conn, &sql, &ctx.params, |r| {
            json!({ "values": {}, "cost": f64_at(r, 0), "listCost": f64_at(r, 1), "usageAmount": f64_at(r, 2), "rowCount": f64_at(r, 3) })
        })?;
        let total = if rows.is_empty() { 0 } else { 1 };
        return Ok(json!({ "rows": rows, "totalRows": total, "tagColumns": ctx.tag_columns }));
    }
    let select_cols: Vec<String> = group_cols
        .iter()
        .map(|c| if c == "usage_date" { "usage_date::VARCHAR AS usage_date".to_string() } else { c.clone() })
        .collect();
    let group_join = group_cols.join(", ");
    let data_sql = format!(
        "SELECT {}, CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(list_cost) AS DOUBLE) AS list_cost, CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount, CAST(COUNT(*) AS DOUBLE) AS row_count FROM {} {} GROUP BY {} ORDER BY SUM(cost) DESC LIMIT {row_limit}",
        select_cols.join(", "), ctx.source, ctx.where_sql, group_join
    );
    let count_sql = format!(
        "SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM (SELECT 1 FROM {} {} GROUP BY {}) _c",
        ctx.source, ctx.where_sql, group_join
    );
    let gc = group_cols.clone();
    let n_data = group_cols.len();
    let data = db::query_map(&conn, &data_sql, &ctx.params, move |r| {
        let mut values = Map::new();
        for (i, col) in gc.iter().enumerate() {
            values.insert(col.clone(), json!(str_at(r, i)));
        }
        json!({
            "values": values,
            "cost": f64_at(r, n_data),
            "listCost": f64_at(r, n_data + 1),
            "usageAmount": f64_at(r, n_data + 2),
            "rowCount": f64_at(r, n_data + 3),
        })
    })?;
    let total_rows = db::query_map(&conn, &count_sql, &ctx.params, |r| f64_at(r, 0))?
        .first()
        .copied()
        .unwrap_or(0.0);
    Ok(json!({ "rows": data, "totalRows": total_rows, "tagColumns": ctx.tag_columns }))
}

#[tauri::command]
pub fn get_explorer_filter_values(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let dim_id = pstr(&o, "dimensionId").ok_or("get_explorer_filter_values: missing dimensionId")?;
    // Facet browsing: exclude the current dim from its own filter set.
    let mut o2 = o.clone();
    if let Some(filters) = o2.get("filters").and_then(|v| v.as_object()).cloned() {
        let pruned: Map<String, J> = filters.into_iter().filter(|(k, _)| k != dim_id).collect();
        o2.insert("filters".into(), J::Object(pruned));
    }
    let ctx = explorer_ctx(&o2, &state)?;
    if ctx.empty {
        return Ok(json!([]));
    }
    let field_expr = query::resolve_field_or_column(dim_id, &ctx.dims)
        .ok_or_else(|| format!("unknown dimension {dim_id:?}"))?;
    let sql = format!(
        "SELECT {field_expr} AS val, CAST(COALESCE(SUM(cost),0) AS DOUBLE) AS total_cost, CAST(COUNT(*) AS DOUBLE) AS row_count FROM {} {} GROUP BY val HAVING val IS NOT NULL AND val != '' ORDER BY total_cost DESC LIMIT 500",
        ctx.source, ctx.where_sql
    );
    let conn = db::open()?;
    let rows = db::query_map(&conn, &sql, &ctx.params, |r| {
        json!({ "value": str_at(r, 0), "label": str_at(r, 0), "cost": f64_at(r, 1), "rows": f64_at(r, 2) })
    })?;
    Ok(J::Array(rows))
}

// ---------------------------------------------------------------------------
// missing tags
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: &[&str] = &[
    "unknown-%", "unknown_%", "unassigned-%", "unassigned_%", "none", "n/a", "tbd",
];

#[tauri::command]
pub fn query_missing_tags(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let tag_dim = pstr(&o, "tagDimension").ok_or("query_missing_tags: missing tagDimension")?;
    let (start, end) = date_range(&o).ok_or("query_missing_tags: missing dateRange")?;
    let min_cost = o.get("minCost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let dims = load_dims(&state)?;
    let periods = available_periods(&state.data_dir, "daily", &start, &end);
    let empty = json!({
        "rows": [], "totalRows": 0, "totalActionableCost": 0.0, "totalLikelyUntaggableCost": 0.0,
        "totalNonResourceCost": 0.0, "actionableCount": 0, "likelyUntaggableCount": 0,
        "unfilteredActionableCount": 0, "unfilteredActionableCost": 0.0,
        "unfilteredLikelyUntaggableCount": 0, "unfilteredLikelyUntaggableCost": 0.0, "nonResourceRows": []
    });
    if periods.is_empty() {
        return Ok(empty);
    }
    if !query::valid_date(&start) || !query::valid_date(&end) {
        return Err("invalid date".into());
    }
    let resolved = query::resolve_field(tag_dim, &dims).ok_or_else(|| format!("unknown dimension {tag_dim:?}"))?;
    let tag_field = resolved.raw_field;
    let source = build_source(&state.data_dir, "daily", &periods, "unblended", &dims);

    let mut tagged = vec![
        format!("{tag_field} IS NOT NULL"),
        format!("{tag_field} != ''"),
    ];
    for p in PLACEHOLDER_PATTERNS {
        tagged.push(format!("{tag_field} NOT ILIKE '{}'", query::sql_escape(p)));
    }
    let is_tagged = tagged.join(" AND ");

    let resources_sql = format!(
        "WITH resources AS (\n  SELECT account_id, account_name, service, service_family, resource_id,\n    SUM(cost) AS cost,\n    MAX(CASE WHEN {is_tagged} THEN 1 ELSE 0 END) AS has_tag,\n    MAX({tag_field}) AS closest_owner\n  FROM {source}\n  WHERE usage_date BETWEEN '{start}' AND '{end}'\n    AND line_item_type IN ('Usage', 'DiscountedUsage')\n    AND resource_id IS NOT NULL AND resource_id != ''\n  GROUP BY account_id, account_name, service, service_family, resource_id\n),\ncategory_coverage AS (\n  SELECT service, service_family,\n    CASE WHEN SUM(cost) > 0 THEN SUM(CASE WHEN has_tag = 1 THEN cost ELSE 0 END) / SUM(cost) ELSE 0 END AS tagged_ratio\n  FROM resources GROUP BY service, service_family\n)\nSELECT r.account_id, r.account_name, r.resource_id, r.service, r.service_family,\n  CAST(r.cost AS DOUBLE) AS cost, r.closest_owner, CAST(c.tagged_ratio AS DOUBLE) AS tagged_ratio,\n  CASE WHEN c.tagged_ratio > 0 THEN 'actionable' ELSE 'likely-untaggable' END AS bucket\nFROM resources r JOIN category_coverage c USING (service, service_family)\nWHERE r.has_tag = 0\nORDER BY r.cost DESC"
    );
    let non_resource_sql = format!(
        "SELECT service, service_family, line_item_type, CAST(SUM(cost) AS DOUBLE) AS cost\nFROM {source}\nWHERE usage_date BETWEEN '{start}' AND '{end}'\n  AND (line_item_type NOT IN ('Usage', 'DiscountedUsage') OR resource_id IS NULL OR resource_id = '')\nGROUP BY service, service_family, line_item_type\nHAVING SUM(cost) > 0\nORDER BY cost DESC"
    );

    let conn = db::open()?;
    struct Res {
        account_id: String,
        account_name: String,
        resource_id: String,
        service: String,
        service_family: String,
        cost: f64,
        closest_owner: String,
        tagged_ratio: f64,
        bucket: String,
    }
    let resources = db::query_map(&conn, &resources_sql, &[], |r| Res {
        account_id: str_at(r, 0),
        account_name: str_at(r, 1),
        resource_id: str_at(r, 2),
        service: str_at(r, 3),
        service_family: str_at(r, 4),
        cost: f64_at(r, 5),
        closest_owner: str_at(r, 6),
        tagged_ratio: f64_at(r, 7),
        bucket: str_at(r, 8),
    })?;

    let mut unf_act_cost = 0.0;
    let mut unf_unt_cost = 0.0;
    let mut unf_act_n = 0i64;
    let mut unf_unt_n = 0i64;
    for r in &resources {
        if r.bucket == "actionable" {
            unf_act_cost += r.cost;
            unf_act_n += 1;
        } else {
            unf_unt_cost += r.cost;
            unf_unt_n += 1;
        }
    }
    let filtered: Vec<&Res> = resources.iter().filter(|r| min_cost <= 0.0 || r.cost >= min_cost).collect();
    let mut act_cost = 0.0;
    let mut unt_cost = 0.0;
    let mut act_n = 0i64;
    let mut unt_n = 0i64;
    for r in &filtered {
        if r.bucket == "actionable" {
            act_cost += r.cost;
            act_n += 1;
        } else {
            unt_cost += r.cost;
            unt_n += 1;
        }
    }
    let rows: Vec<J> = filtered
        .iter()
        .take(5000)
        .map(|r| {
            json!({
                "accountId": r.account_id, "accountName": r.account_name, "resourceId": r.resource_id,
                "service": r.service, "serviceFamily": r.service_family, "cost": r.cost,
                "closestOwner": if r.closest_owner.is_empty() { J::Null } else { json!(r.closest_owner) },
                "bucket": r.bucket, "categoryTaggedRatio": r.tagged_ratio,
            })
        })
        .collect();

    let mut non_resource_cost = 0.0;
    let non_resource = db::query_map(&conn, &non_resource_sql, &[], |r| {
        let cost = f64_at(r, 3);
        (str_at(r, 0), str_at(r, 1), str_at(r, 2), cost)
    })?;
    let non_resource_rows: Vec<J> = non_resource
        .into_iter()
        .map(|(service, family, lit, cost)| {
            non_resource_cost += cost;
            json!({ "service": service, "serviceFamily": family, "lineItemType": lit, "cost": cost })
        })
        .collect();

    Ok(json!({
        "rows": rows,
        "totalRows": filtered.len(),
        "totalActionableCost": act_cost,
        "totalLikelyUntaggableCost": unt_cost,
        "totalNonResourceCost": non_resource_cost,
        "actionableCount": act_n,
        "likelyUntaggableCount": unt_n,
        "unfilteredActionableCount": unf_act_n,
        "unfilteredActionableCost": unf_act_cost,
        "unfilteredLikelyUntaggableCount": unf_unt_n,
        "unfilteredLikelyUntaggableCost": unf_unt_cost,
        "nonResourceRows": non_resource_rows,
    }))
}

// ---------------------------------------------------------------------------
// dimensions discovery (settings view)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn discover_tag_keys(state: tauri::State<AppState>) -> R {
    let months = list_local_months(&state.data_dir, "daily");
    let sample = months.last().cloned().unwrap_or_default();
    if sample.is_empty() {
        return Ok(json!({ "tags": [], "samplePeriod": "" }));
    }
    let glob = format!("'{}/aws/raw/daily-{}/*.parquet'", query::sql_escape(&state.data_dir), sample);
    let sql = format!(
        "WITH kv AS (SELECT unnest(map_keys(resource_tags)) AS k, unnest(map_values(resource_tags)) AS v FROM read_parquet({glob})),\n\
         total AS (SELECT COUNT(*) AS n FROM read_parquet({glob}))\n\
         SELECT k, CAST(COUNT(*) AS DOUBLE) AS rows, CAST(COUNT(DISTINCT v) AS DOUBLE) AS distinct_count, (SELECT n FROM total) AS total_rows,\n\
                list_string_agg(DISTINCT v) AS samples\n\
         FROM kv GROUP BY k ORDER BY rows DESC"
    );
    let conn = db::open()?;
    // list_string_agg may not exist; fall back to string_agg
    let sql = sql.replace("list_string_agg(DISTINCT v)", "string_agg(DISTINCT v, '||')");
    let rows = db::query_map(&conn, &sql, &[], |r| {
        let key = str_at(r, 0);
        let rows_n = f64_at(r, 1);
        let distinct = f64_at(r, 2);
        let total = f64_at(r, 3);
        let samples = str_at(r, 4);
        let sample_values: Vec<String> = samples.split("||").filter(|s| !s.is_empty()).take(5).map(|s| s.to_string()).collect();
        let coverage = if total > 0.0 { rows_n / total * 100.0 } else { 0.0 };
        // strip leading user_ for display key, matching CUR convention
        let display = key.strip_prefix("user_").unwrap_or(&key).to_string();
        json!({
            "key": display, "sampleValues": sample_values, "rowCount": rows_n,
            "distinctCount": distinct, "coveragePct": coverage,
        })
    })?;
    Ok(json!({ "tags": rows, "samplePeriod": sample }))
}

#[tauri::command]
pub fn discover_column_values(params: J, state: tauri::State<AppState>) -> R {
    let o = pobj(&params);
    let field = pstr(&o, "field").ok_or("discover_column_values: missing field")?;
    let dims = load_dims(&state)?;
    let months = list_local_months(&state.data_dir, "daily");
    let sample = months.last().cloned().unwrap_or_default();
    if sample.is_empty() {
        return Ok(json!({ "values": [], "distinctCount": 0, "period": "" }));
    }
    let source = build_source(&state.data_dir, "daily", std::slice::from_ref(&sample), "unblended", &dims);
    let field_expr = query::resolve_field_or_column(field, &dims).unwrap_or_else(|| field.to_string());
    let sql = format!(
        "SELECT {field_expr} AS val, CAST(SUM(cost) AS DOUBLE) AS cost FROM {source} GROUP BY val HAVING val IS NOT NULL AND val != '' ORDER BY cost DESC LIMIT 1000"
    );
    let conn = db::open()?;
    let rows = db::query_map(&conn, &sql, &[], |r| json!({ "value": str_at(r, 0), "cost": f64_at(r, 1) }))?;
    let count = rows.len();
    Ok(json!({ "values": rows, "distinctCount": count, "period": sample }))
}
