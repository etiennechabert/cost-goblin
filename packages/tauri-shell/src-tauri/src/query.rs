//! SQL builders ported from `@costgoblin/core`'s query/builder.ts and the
//! desktop explorer handler. Faithful to the originals for the fixture config
//! (no org-account join, cost scope rules all disabled, unblended/gross).
//!
//! Security model for the spike: date strings are strictly validated
//! (`YYYY-MM-DD`) then interpolated; arbitrary filter values are bound as
//! parameters via `Qb`. This keeps untrusted strings out of the SQL text while
//! avoiding placeholder-reuse bookkeeping for the heavily-reused date bounds.

use crate::config::{Dimensions, Tag};
use crate::db::Qb;
use std::collections::BTreeMap;
use std::path::Path;

pub const SOURCE_COLUMNS: &[&str] = &[
    "usage_date",
    "usage_hour",
    "account_id",
    "account_name",
    "region",
    "service",
    "service_family",
    "line_item_type",
    "operation",
    "usage_type",
    "description",
    "resource_id",
    "usage_amount",
    "cost",
    "list_cost",
];

pub fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, &c)| if i == 4 || i == 7 { c == b'-' } else { c.is_ascii_digit() })
}

fn assert_date(s: &str) -> Result<&str, String> {
    if valid_date(s) {
        Ok(s)
    } else {
        Err(format!("invalid date string: {s:?}"))
    }
}

pub fn sanitize_tag_col(tag_name: &str) -> String {
    let cleaned: String = tag_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("tag_{cleaned}")
}

pub fn tag_dim_column(t: &Tag) -> String {
    match &t.tag_name {
        Some(tn) if !tn.is_empty() => sanitize_tag_col(tn),
        _ => match &t.account_tag_fallback {
            Some(f) if f == "__ouPath__" => sanitize_tag_col("ou_path"),
            Some(f) if !f.is_empty() => sanitize_tag_col(f),
            _ => sanitize_tag_col("unknown"),
        },
    }
}

fn normalize_sql(rule: &str, expr: &str) -> String {
    match rule {
        "lowercase" => format!("LOWER({expr})"),
        "uppercase" => format!("UPPER({expr})"),
        "lowercase-kebab" => format!(
            r"LOWER(REGEXP_REPLACE(REGEXP_REPLACE({expr}, '([a-z])([A-Z])', '\1-\2', 'g'), '[_\s]+', '-', 'g'))"
        ),
        "lowercase-underscore" => format!(
            r"LOWER(REGEXP_REPLACE(REGEXP_REPLACE({expr}, '([a-z])([A-Z])', '\1_\2', 'g'), '[-\s]+', '_', 'g'))"
        ),
        // camelCase mirrors core's list_transform construction.
        "camelCase" => {
            let joined = format!(
                "array_to_string(list_transform(regexp_split_to_array({expr}, '[-_ ]+'), \
                 (w, i) -> CASE WHEN i = 1 OR length(w) = 0 THEN w \
                 ELSE upper(substr(w, 1, 1)) || substr(w, 2) END), '')"
            );
            format!("(lower(substr({joined}, 1, 1)) || substr({joined}, 2))")
        }
        _ => expr.to_string(),
    }
}

pub fn build_alias_sql_case(
    field: &str,
    normalize: &Option<String>,
    aliases: &Option<BTreeMap<String, Vec<String>>>,
) -> String {
    let mut expr = field.to_string();
    if let Some(rule) = normalize {
        expr = normalize_sql(rule, &expr);
    }
    let Some(aliases) = aliases else {
        return expr;
    };
    if aliases.is_empty() {
        return expr;
    }
    let cases: Vec<String> = aliases
        .iter()
        .map(|(canonical, list)| {
            let vals: Vec<String> = list.iter().map(|a| format!("'{}'", sql_escape(a))).collect();
            format!(
                "WHEN {expr} IN ({}) THEN '{}'",
                vals.join(", "),
                sql_escape(canonical)
            )
        })
        .collect();
    format!("CASE {} ELSE {expr} END", cases.join(" "))
}

pub struct Resolved {
    pub field_expr: String,
    pub raw_field: String,
}

/// Resolve a dimension id to its SQL field expression. The `account` built-in
/// is grouped by `account_name` (its displayField) so labels and filters stay
/// self-consistent without an account-id↔name reverse map.
pub fn resolve_field(dim_id: &str, dims: &Dimensions) -> Option<Resolved> {
    if let Some(b) = dims.built_in.iter().find(|b| b.name == dim_id) {
        let raw = if b.field == "account_id" {
            "account_name".to_string()
        } else {
            b.field.clone()
        };
        let field_expr = build_alias_sql_case(&raw, &b.normalize, &b.aliases);
        return Some(Resolved { field_expr, raw_field: raw });
    }
    if let Some(t) = dims.tags.iter().find(|t| tag_dim_column(t) == dim_id) {
        let raw = tag_dim_column(t);
        let field_expr = build_alias_sql_case(&raw, &t.normalize, &t.aliases);
        return Some(Resolved { field_expr, raw_field: raw });
    }
    None
}

/// Field expression for a raw column or dimension id (explorer-style). Falls
/// back to the literal column name when it's a known source/tag column.
pub fn resolve_field_or_column(dim_id: &str, dims: &Dimensions) -> Option<String> {
    if let Some(r) = resolve_field(dim_id, dims) {
        return Some(r.field_expr);
    }
    let is_tag = dims.tags.iter().any(|t| tag_dim_column(t) == dim_id);
    if SOURCE_COLUMNS.contains(&dim_id) || is_tag {
        return Some(dim_id.to_string());
    }
    None
}

fn cost_expr(metric: &str) -> &'static str {
    match metric {
        // fixtures lack reservation/savings-plan effective-cost columns, so
        // amortized degrades to unblended — exactly as core's costExprFor does.
        "list" => "COALESCE(pricing_public_on_demand_cost, 0)",
        _ => "COALESCE(line_item_unblended_cost, 0)",
    }
}

fn build_parquet_source(data_dir: &str, tier: &str, periods: &[String]) -> String {
    if !periods.is_empty() {
        let paths: Vec<String> = periods
            .iter()
            .map(|p| format!("'{}/aws/raw/{}-{}/*.parquet'", sql_escape(data_dir), tier, p))
            .collect();
        format!("read_parquet([{}])", paths.join(", "))
    } else {
        format!("read_parquet('{}/aws/raw/{}-*/*.parquet')", sql_escape(data_dir), tier)
    }
}

pub fn build_source(
    data_dir: &str,
    tier: &str,
    periods: &[String],
    metric: &str,
    dims: &Dimensions,
) -> String {
    let date_expr = if tier == "hourly" {
        "line_item_usage_start_date::DATE AS usage_date,\n      line_item_usage_start_date::TIMESTAMP AS usage_hour"
    } else {
        "line_item_usage_start_date::DATE AS usage_date"
    };
    let tag_selects: Vec<String> = dims
        .tags
        .iter()
        .filter_map(|t| {
            let tn = t.tag_name.as_ref()?;
            if tn.is_empty() {
                return None;
            }
            let col = tag_dim_column(t);
            let key = if tn.starts_with("user_") {
                tn.clone()
            } else {
                format!("user_{tn}")
            };
            Some(format!(
                "element_at(resource_tags, '{}')[1] AS {col}",
                sql_escape(&key)
            ))
        })
        .collect();
    let tag_clause = if tag_selects.is_empty() {
        String::new()
    } else {
        format!(",\n      {}", tag_selects.join(",\n      "))
    };
    let parquet = build_parquet_source(data_dir, tier, periods);
    let metric_where = if metric == "list" {
        "\n    WHERE COALESCE(line_item_line_item_type, '') IN ('Usage', 'SavingsPlanCoveredUsage', 'DiscountedUsage')"
    } else {
        ""
    };
    let ce = cost_expr(metric);
    format!(
        "(\n    SELECT\n      {date_expr},\n      \
         line_item_usage_account_id AS account_id,\n      \
         COALESCE(line_item_usage_account_name, '') AS account_name,\n      \
         COALESCE(product_region_code, '') AS region,\n      \
         COALESCE(product_servicecode, '') AS service,\n      \
         COALESCE(product_product_family, '') AS service_family,\n      \
         COALESCE(line_item_line_item_description, '') AS description,\n      \
         COALESCE(line_item_usage_amount, 0) AS usage_amount,\n      \
         COALESCE(pricing_public_on_demand_cost, 0) AS list_cost,\n      \
         COALESCE(line_item_resource_id, '') AS resource_id,\n      \
         {ce} AS cost,\n      \
         COALESCE(line_item_line_item_type, '') AS line_item_type,\n      \
         COALESCE(line_item_operation, '') AS operation,\n      \
         COALESCE(line_item_usage_type, '') AS usage_type{tag_clause}\n    \
         FROM {parquet}{metric_where}\n  )"
    )
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

pub fn compute_periods_in_range(start: &str, end: &str) -> Vec<String> {
    if !valid_date(start) || !valid_date(end) {
        return vec![];
    }
    let (sy, sm) = (start[0..4].parse::<i64>().unwrap_or(0), start[5..7].parse::<i64>().unwrap_or(0));
    let (ey, em) = (end[0..4].parse::<i64>().unwrap_or(0), end[5..7].parse::<i64>().unwrap_or(0));
    let start_idx = sy * 12 + (sm - 1);
    let end_idx = ey * 12 + (em - 1);
    if start_idx > end_idx {
        return vec![];
    }
    (start_idx..=end_idx)
        .map(|idx| {
            let y = idx / 12;
            let m = idx % 12 + 1;
            format!("{y:04}-{m:02}")
        })
        .collect()
}

pub fn list_local_months(data_dir: &str, tier: &str) -> Vec<String> {
    let raw_dir = Path::new(data_dir).join("aws").join("raw");
    let prefix = format!("{tier}-");
    let mut months = vec![];
    if let Ok(entries) = std::fs::read_dir(&raw_dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if let Some(month) = name.strip_prefix(&prefix) {
                    months.push(month.to_string());
                }
            }
        }
    }
    months.sort();
    months
}

/// required-months ∩ on-disk-months. Empty means "no data for this window".
pub fn available_periods(data_dir: &str, tier: &str, start: &str, end: &str) -> Vec<String> {
    let required = compute_periods_in_range(start, end);
    let local = list_local_months(data_dir, tier);
    required.into_iter().filter(|p| local.contains(p)).collect()
}

// civil <-> days for trend's previous-period span (no chrono dependency).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn date_to_days(s: &str) -> i64 {
    days_from_civil(
        s[0..4].parse().unwrap_or(1970),
        s[5..7].parse().unwrap_or(1),
        s[8..10].parse().unwrap_or(1),
    )
}

pub fn days_to_date(d: i64) -> String {
    let (y, m, day) = civil_from_days(d);
    format!("{y:04}-{m:02}-{day:02}")
}

/// Whole days since the Unix epoch, from the system clock.
pub fn epoch_days_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

/// Inclusive day count between two ISO dates.
pub fn window_days(start: &str, end: &str) -> i64 {
    (date_to_days(end) - date_to_days(start)) + 1
}

// ---------------------------------------------------------------------------
// Filter clauses (parameterized)
// ---------------------------------------------------------------------------

/// Build WHERE clauses for a FilterMap (dimId -> values). Values are bound as
/// parameters. Unknown dims are skipped (matches core's tolerant behaviour for
/// filter-values / explorer predicates).
pub fn filter_clauses(
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    qb: &mut Qb,
) -> Vec<String> {
    let mut clauses = vec![];
    for (dim_id, raw_vals) in filters {
        let Some(arr) = raw_vals.as_array() else { continue };
        let values: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        if values.is_empty() {
            continue;
        }
        let Some(field_expr) = resolve_field_or_column(dim_id, dims) else { continue };
        if values.len() == 1 {
            let ph = qb.text(values[0].clone());
            clauses.push(format!("{field_expr} = {ph}"));
        } else {
            let list: Vec<String> = values.into_iter().map(|v| qb.text(v)).collect();
            clauses.push(format!("{field_expr} IN ({})", list.join(", ")));
        }
    }
    clauses
}

fn where_str(clauses: &[String]) -> String {
    if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    }
}

// ---------------------------------------------------------------------------
// Query builders. Each returns (sql, params).
// ---------------------------------------------------------------------------

pub struct Built {
    pub sql: String,
    pub params: Vec<duckdb::types::Value>,
}

pub fn cost_query(
    group_by: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    source: &str,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let group = resolve_field(group_by, dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let mut qb = Qb::new();
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'")];
    wheres.extend(filter_clauses(filters, dims, &mut qb));
    let sql = format!(
        "WITH base AS (\n  SELECT {ge} AS entity, service, SUM(cost) AS cost\n  FROM {source}\n  WHERE {w}\n  GROUP BY entity, service\n),\n\
         top_services AS (SELECT service FROM base GROUP BY service ORDER BY SUM(cost) DESC LIMIT 5),\n\
         entity_totals AS (SELECT entity, SUM(cost) AS total_cost FROM base GROUP BY entity)\n\
         SELECT et.entity, CAST(et.total_cost AS DOUBLE) AS total_cost, b.service, CAST(COALESCE(b.cost, 0) AS DOUBLE) AS service_cost\n\
         FROM entity_totals et\n  LEFT JOIN base b ON et.entity = b.entity AND b.service IN (SELECT service FROM top_services)\n  ORDER BY et.total_cost DESC",
        ge = group.field_expr,
        w = wheres.join(" AND "),
    );
    Ok(Built { sql, params: qb.params })
}

pub fn daily_costs_query(
    group_by: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    source: &str,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let group = resolve_field(group_by, dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let mut qb = Qb::new();
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'")];
    wheres.extend(filter_clauses(filters, dims, &mut qb));
    let sql = format!(
        "SELECT usage_date::VARCHAR AS date, {ge} AS group_name, CAST(SUM(cost) AS DOUBLE) AS cost\n\
         FROM {source}\n  WHERE {w}\n  GROUP BY date, group_name\n  ORDER BY date, cost DESC",
        ge = group.field_expr,
        w = wheres.join(" AND "),
    );
    Ok(Built { sql, params: qb.params })
}

/// Periods covering both the current window and the same-length previous one.
pub fn trend_periods(data_dir: &str, start: &str, end: &str) -> Vec<String> {
    let start_d = date_to_days(start);
    let end_d = date_to_days(end);
    let duration = (end_d - start_d) + 1;
    let prev_start = days_to_date(start_d - duration);
    let mut required = compute_periods_in_range(&prev_start, end);
    required.dedup();
    let local = list_local_months(data_dir, "daily");
    required.into_iter().filter(|p| local.contains(p)).collect()
}

pub fn trend_query(
    group_by: &str,
    start: &str,
    end: &str,
    delta_threshold: f64,
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    source: &str,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let group = resolve_field(group_by, dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let mut qb = Qb::new();
    let filt = filter_clauses(filters, dims, &mut qb);
    let filt_where = if filt.is_empty() {
        String::new()
    } else {
        format!(" AND {}", filt.join(" AND "))
    };
    let delta = if delta_threshold.is_finite() && delta_threshold >= 0.0 {
        delta_threshold
    } else {
        0.0
    };
    let sql = format!(
        "WITH bucketed AS (\n  SELECT {ge} AS entity,\n    \
         CASE WHEN usage_date BETWEEN '{start}' AND '{end}' THEN 'current' ELSE 'previous' END AS period,\n    cost\n  \
         FROM {source}\n  WHERE usage_date BETWEEN\n    \
         CAST('{start}' AS DATE) - (DATEDIFF('day', CAST('{start}' AS DATE), CAST('{end}' AS DATE)) + 1) * INTERVAL '1 day'\n    \
         AND '{end}'{filt_where}\n),\n\
         agg AS (\n  SELECT entity,\n    SUM(CASE WHEN period = 'current' THEN cost ELSE 0 END) AS current_cost,\n    \
         SUM(CASE WHEN period = 'previous' THEN cost ELSE 0 END) AS previous_cost\n  FROM bucketed\n  GROUP BY entity\n)\n\
         SELECT entity, CAST(current_cost AS DOUBLE) AS current_cost, CAST(previous_cost AS DOUBLE) AS previous_cost,\n    \
         CAST(current_cost - previous_cost AS DOUBLE) AS delta,\n    \
         CASE WHEN previous_cost = 0 THEN NULL ELSE (current_cost - previous_cost) / previous_cost * 100 END AS percent_change\n  \
         FROM agg\n  WHERE ABS(current_cost - previous_cost) >= {delta}\n  ORDER BY ABS(current_cost - previous_cost) DESC",
        ge = group.field_expr,
    );
    Ok(Built { sql, params: qb.params })
}

pub fn entity_detail_query(
    dimension: &str,
    entity: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    source: &str,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let dim = resolve_field(dimension, dims).ok_or_else(|| format!("unknown dimension {dimension:?}"))?;
    let mut qb = Qb::new();
    let entity_ph = qb.text(entity.to_string());
    let mut wheres = vec![
        format!("usage_date BETWEEN '{start}' AND '{end}'"),
        format!("{} = {entity_ph}", dim.field_expr),
    ];
    wheres.extend(filter_clauses(filters, dims, &mut qb));
    let sql = format!(
        "SELECT usage_date::VARCHAR AS usage_date, service, account_id, account_name, CAST(SUM(cost) AS DOUBLE) AS cost\n\
         FROM {source}\n  WHERE {w}\n  GROUP BY usage_date, service, account_id, account_name\n  ORDER BY usage_date, cost DESC",
        w = wheres.join(" AND "),
    );
    Ok(Built { sql, params: qb.params })
}

pub fn filter_values_query(
    dim_id: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    source: &str,
) -> Result<Built, String> {
    let field_expr = resolve_field_or_column(dim_id, dims)
        .ok_or_else(|| format!("unknown dimension {dim_id:?}"))?;
    let mut qb = Qb::new();
    let mut wheres = filter_clauses(filters, dims, &mut qb);
    if valid_date(start) && valid_date(end) {
        wheres.push(format!("usage_date BETWEEN '{start}' AND '{end}'"));
    }
    let sql = format!(
        "SELECT {field_expr} AS val, CAST(SUM(cost) AS DOUBLE) AS total_cost, CAST(COUNT(*) AS DOUBLE) AS row_count\n\
         FROM {source}\n  {w}\n  GROUP BY val\n  HAVING val IS NOT NULL AND val != ''\n  ORDER BY total_cost DESC\n  LIMIT 500",
        w = where_str(&wheres),
    );
    Ok(Built { sql, params: qb.params })
}
