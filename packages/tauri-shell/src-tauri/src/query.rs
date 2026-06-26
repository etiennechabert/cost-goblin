//! SQL builders ported from `@costgoblin/core`'s query/builder.ts + cost-metric
//! + normalize, faithful enough to run a real CUR dataset: org-account join for
//! tag fallbacks, cost-metric selection (unblended | list | amortized),
//! cost-scope exclusions, and normalize/alias CASE.
//!
//! Security model: date strings are validated (`YYYY-MM-DD`) then interpolated;
//! arbitrary filter values are bound as parameters. Config-derived literals
//! (cost-scope values, fallback keys, paths) are escaped and interpolated, as in
//! the TS `buildRuleMatchExpr`/`buildSource` non-qb paths.

use crate::config::{Dimensions, PathSeg, Tag};
use crate::db::Qb;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub const SOURCE_COLUMNS: &[&str] = &[
    "usage_date", "usage_hour", "account_id", "account_name", "region", "service",
    "service_family", "line_item_type", "operation", "usage_type", "description",
    "resource_id", "usage_amount", "cost", "list_cost",
];

pub fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, &c)| if i == 4 || i == 7 { c == b'-' } else { c.is_ascii_digit() })
}

fn assert_date(s: &str) -> Result<&str, String> {
    if valid_date(s) { Ok(s) } else { Err(format!("invalid date string: {s:?}")) }
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

// --- normalize (JS applyNormalizationRule mirror, for rule-value normalization) ---
fn apply_normalization(value: &str, rule: &str) -> String {
    match rule {
        "lowercase" => value.to_lowercase(),
        "uppercase" => value.to_uppercase(),
        "lowercase-kebab" => kebab_or_underscore(value, '-'),
        "lowercase-underscore" => kebab_or_underscore(value, '_'),
        _ => value.to_string(),
    }
}

fn kebab_or_underscore(value: &str, sep: char) -> String {
    // insert sep on lower->Upper boundaries, collapse [_\s-] runs to sep, lower.
    let mut out = String::new();
    let chars: Vec<char> = value.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
            out.push(sep);
        }
        out.push(c);
    }
    let mut res = String::new();
    let mut prev_sep = false;
    for c in out.chars() {
        if c == '_' || c == '-' || c.is_whitespace() {
            if !prev_sep {
                res.push(sep);
                prev_sep = true;
            }
        } else {
            res.push(c);
            prev_sep = false;
        }
    }
    res.to_lowercase()
}

fn resolve_alias(value: &str, aliases: &Option<BTreeMap<String, Vec<String>>>) -> String {
    let Some(aliases) = aliases else { return value.to_string() };
    for (canonical, list) in aliases {
        if canonical == value || list.iter().any(|a| a == value) {
            return canonical.clone();
        }
    }
    value.to_string()
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
    let Some(aliases) = aliases else { return expr };
    if aliases.is_empty() {
        return expr;
    }
    let cases: Vec<String> = aliases
        .iter()
        .map(|(canonical, list)| {
            let vals: Vec<String> = list.iter().map(|a| format!("'{}'", sql_escape(a))).collect();
            format!("WHEN {expr} IN ({}) THEN '{}'", vals.join(", "), sql_escape(canonical))
        })
        .collect();
    format!("CASE {} ELSE {expr} END", cases.join(" "))
}

pub struct Resolved {
    pub field_expr: String,
    pub raw_field: String,
    pub normalize: Option<String>,
    pub aliases: Option<BTreeMap<String, Vec<String>>>,
}

/// Resolve a dimension id to its SQL field expression. The `account` built-in
/// keeps its raw `account_id` field — display names are mapped in Rust.
pub fn resolve_field(dim_id: &str, dims: &Dimensions) -> Option<Resolved> {
    if let Some(b) = dims.built_in.iter().find(|b| b.name == dim_id) {
        let field_expr = build_alias_sql_case(&b.field, &b.normalize, &b.aliases);
        return Some(Resolved {
            field_expr,
            raw_field: b.field.clone(),
            normalize: b.normalize.clone(),
            aliases: b.aliases.clone(),
        });
    }
    if let Some(t) = dims.tags.iter().find(|t| tag_dim_column(t) == dim_id) {
        let raw = tag_dim_column(t);
        let field_expr = build_alias_sql_case(&raw, &t.normalize, &t.aliases);
        return Some(Resolved {
            field_expr,
            raw_field: raw,
            normalize: t.normalize.clone(),
            aliases: t.aliases.clone(),
        });
    }
    None
}

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

// --- source construction (org-account join + cost metric) ---

fn cost_expr(metric: &str, prefix: &str, net: bool) -> String {
    let unblended = if net {
        format!("{prefix}line_item_net_unblended_cost")
    } else {
        format!("{prefix}line_item_unblended_cost")
    };
    match metric {
        "list" => format!("COALESCE({prefix}pricing_public_on_demand_cost, 0)"),
        "amortized" => {
            let ri = if net {
                format!("{prefix}reservation_net_effective_cost")
            } else {
                format!("{prefix}reservation_effective_cost")
            };
            let sp = if net {
                format!("{prefix}savings_plan_net_savings_plan_effective_cost")
            } else {
                format!("{prefix}savings_plan_savings_plan_effective_cost")
            };
            let lit = format!("{prefix}line_item_line_item_type");
            format!(
                "CASE WHEN {lit} = 'DiscountedUsage' THEN COALESCE({ri}, {unblended}, 0) \
                 WHEN {lit} = 'SavingsPlanCoveredUsage' THEN COALESCE({sp}, {unblended}, 0) \
                 WHEN {lit} IN ('RIFee', 'SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'SavingsPlanNegation') THEN 0 \
                 ELSE COALESCE({unblended}, 0) END"
            )
        }
        _ => format!("COALESCE({unblended}, 0)"),
    }
}

fn build_tag_value_expr(t: &Tag, needs_org_join: bool, col_name: &str) -> String {
    let has_resource_tag = t.tag_name.as_deref().map_or(false, |n| !n.is_empty());
    let has_fallback = t.account_tag_fallback.is_some();
    if !has_resource_tag {
        if needs_org_join && has_fallback {
            return format!("acct_tags.fallback_{col_name}");
        }
        return "NULL".to_string();
    }
    let tag_name = t.tag_name.clone().unwrap_or_default();
    let raw_key = if tag_name.starts_with("user_") {
        tag_name
    } else {
        format!("user_{tag_name}")
    };
    let cur_key = sql_escape(&raw_key);
    let prefix = if needs_org_join { "cur." } else { "" };
    let resource_expr = format!("element_at({prefix}resource_tags, '{cur_key}')[1]");
    if !has_fallback || !needs_org_join {
        return resource_expr;
    }
    let fallback_expr = format!("acct_tags.fallback_{col_name}");
    if let Some(tmpl) = &t.missing_value_template {
        if !tmpl.is_empty() && tmpl != "{fallback}" {
            let parts: Vec<&str> = tmpl.splitn(2, "{fallback}").collect();
            let pre = sql_escape(parts.first().copied().unwrap_or(""));
            let suf = sql_escape(parts.get(1).copied().unwrap_or(""));
            let formatted = format!("'{pre}' || {fallback_expr} || '{suf}'");
            return format!("COALESCE(NULLIF({resource_expr}, ''), {formatted})");
        }
    }
    format!("COALESCE(NULLIF({resource_expr}, ''), {fallback_expr})")
}

fn apply_path_segment(expr: String, ps: &Option<PathSeg>) -> String {
    match ps {
        None => expr,
        Some(p) => {
            let sep = sql_escape(&p.separator);
            format!("NULLIF(split_part({expr}, '{sep}', {}), '')", p.index)
        }
    }
}

fn build_tag_select(t: &Tag, needs_org_join: bool) -> String {
    let col = tag_dim_column(t);
    let val = build_tag_value_expr(t, needs_org_join, &col);
    let wrapped = apply_path_segment(val, &t.path_segment);
    format!("{wrapped} AS {col}")
}

fn build_from_clause(parquet_source: &str, dims: &Dimensions, org_path: &str) -> String {
    let fallback_selects: Vec<String> = dims
        .tags
        .iter()
        .filter(|t| t.account_tag_fallback.is_some())
        .map(|t| {
            let col = tag_dim_column(t);
            let fb = t.account_tag_fallback.clone().unwrap_or_default();
            if fb == "__ouPath__" {
                format!("ouPath AS fallback_{col}")
            } else {
                format!("tags->>'{}' AS fallback_{col}", sql_escape(&fb))
            }
        })
        .collect();
    format!(
        "{parquet_source} AS cur\n      LEFT JOIN (\n        SELECT id, {}\n        FROM read_json_auto('{}')\n      ) AS acct_tags ON cur.line_item_usage_account_id = acct_tags.id",
        fallback_selects.join(", "),
        sql_escape(org_path)
    )
}

fn build_parquet_source(data_dir: &str, tier: &str, periods: &[String]) -> String {
    // union_by_name=true tolerates CUR schema drift across months (older exports
    // lack columns like reservation_effective_cost) — matches core's #398 fix;
    // without it a multi-month read errors on mismatched schemas.
    if !periods.is_empty() {
        let paths: Vec<String> = periods
            .iter()
            .map(|p| format!("'{}/aws/raw/{}-{}/*.parquet'", sql_escape(data_dir), tier, p))
            .collect();
        format!("read_parquet([{}], union_by_name=true)", paths.join(", "))
    } else {
        format!("read_parquet('{}/aws/raw/{}-*/*.parquet', union_by_name=true)", sql_escape(data_dir), tier)
    }
}

pub fn build_source(
    data_dir: &str,
    tier: &str,
    periods: &[String],
    metric: &str,
    net: bool,
    dims: &Dimensions,
    org_path: Option<&str>,
) -> String {
    let has_fallbacks = dims.tags.iter().any(|t| t.account_tag_fallback.is_some());
    let needs_org_join = has_fallbacks && org_path.is_some();
    let prefix = if needs_org_join { "cur." } else { "" };

    let tag_selects: Vec<String> = dims.tags.iter().map(|t| build_tag_select(t, needs_org_join)).collect();
    let tag_clause = if tag_selects.is_empty() {
        String::new()
    } else {
        format!(",\n      {}", tag_selects.join(",\n      "))
    };

    let date_expr = if tier == "hourly" {
        format!(
            "{prefix}line_item_usage_start_date::DATE AS usage_date,\n      {prefix}line_item_usage_start_date::TIMESTAMP AS usage_hour"
        )
    } else {
        format!("{prefix}line_item_usage_start_date::DATE AS usage_date")
    };

    let parquet = build_parquet_source(data_dir, tier, periods);
    let from_clause = if needs_org_join {
        build_from_clause(&parquet, dims, org_path.unwrap_or(""))
    } else {
        parquet
    };
    let ce = cost_expr(metric, prefix, net);
    let metric_where = if metric == "list" {
        format!("\n    WHERE COALESCE({prefix}line_item_line_item_type, '') IN ('Usage', 'SavingsPlanCoveredUsage', 'DiscountedUsage')")
    } else {
        String::new()
    };

    format!(
        "(\n    SELECT\n      {date_expr},\n      \
         {prefix}line_item_usage_account_id AS account_id,\n      \
         COALESCE({prefix}line_item_usage_account_name, '') AS account_name,\n      \
         COALESCE({prefix}product_region_code, '') AS region,\n      \
         COALESCE({prefix}product_servicecode, '') AS service,\n      \
         COALESCE({prefix}product_product_family, '') AS service_family,\n      \
         COALESCE({prefix}line_item_line_item_description, '') AS description,\n      \
         COALESCE({prefix}line_item_usage_amount, 0) AS usage_amount,\n      \
         COALESCE({prefix}pricing_public_on_demand_cost, 0) AS list_cost,\n      \
         COALESCE({prefix}line_item_resource_id, '') AS resource_id,\n      \
         {ce} AS cost,\n      \
         COALESCE({prefix}line_item_line_item_type, '') AS line_item_type,\n      \
         COALESCE({prefix}line_item_operation, '') AS operation,\n      \
         COALESCE({prefix}line_item_usage_type, '') AS usage_type{tag_clause}\n    \
         FROM {from_clause}{metric_where}\n  )"
    )
}

// --- cost-scope exclusions ---

fn normalize_rule_value(value: &str, r: &Resolved) -> String {
    let normalized = match &r.normalize {
        Some(rule) => apply_normalization(value, rule),
        None => value.to_string(),
    };
    resolve_alias(&normalized, &r.aliases)
}

/// `NOT (...)` clauses for each enabled cost-scope rule. Values are escaped
/// literals (config-derived), matching core's qb-less buildRuleMatchExpr path.
pub fn build_exclusion_clauses(cost_scope: &crate::config::CostScope, dims: &Dimensions) -> Vec<String> {
    let mut clauses = vec![];
    for rule in &cost_scope.rules {
        if !rule.enabled {
            continue;
        }
        let mut cond_sqls = vec![];
        for cond in &rule.conditions {
            if cond.values.is_empty() {
                continue;
            }
            let Some(r) = resolve_field(&cond.dimension_id, dims) else { continue };
            let vals: Vec<String> = cond
                .values
                .iter()
                .map(|v| format!("'{}'", sql_escape(&normalize_rule_value(v, &r))))
                .collect();
            cond_sqls.push(format!("{} IN ({})", r.field_expr, vals.join(", ")));
        }
        if !cond_sqls.is_empty() {
            clauses.push(format!("NOT ({})", cond_sqls.join(" AND ")));
        }
    }
    clauses
}

// --- period helpers ---

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
        .map(|idx| format!("{:04}-{:02}", idx / 12, idx % 12 + 1))
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

pub fn available_periods(data_dir: &str, tier: &str, start: &str, end: &str) -> Vec<String> {
    let required = compute_periods_in_range(start, end);
    let local = list_local_months(data_dir, tier);
    required.into_iter().filter(|p| local.contains(p)).collect()
}

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

pub fn epoch_days_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

pub fn window_days(start: &str, end: &str) -> i64 {
    (date_to_days(end) - date_to_days(start)) + 1
}

// --- filter clauses (parameterized; account names expanded to ids) ---

pub fn filter_clauses(
    filters: &serde_json::Map<String, serde_json::Value>,
    dims: &Dimensions,
    account_reverse: Option<&HashMap<String, Vec<String>>>,
    qb: &mut Qb,
) -> Vec<String> {
    let mut clauses = vec![];
    for (dim_id, raw_vals) in filters {
        let Some(arr) = raw_vals.as_array() else { continue };
        let values: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
        if values.is_empty() {
            continue;
        }
        let resolved = resolve_field(dim_id, dims);
        let raw_field = resolved.as_ref().map(|r| r.raw_field.clone());
        // account display-name → id expansion
        if raw_field.as_deref() == Some("account_id") {
            if let Some(rev) = account_reverse {
                let mut ids = vec![];
                let mut used = false;
                for v in &values {
                    if let Some(mapped) = rev.get(v) {
                        ids.extend(mapped.iter().cloned());
                        used = true;
                    } else {
                        ids.push(v.clone());
                    }
                }
                if used {
                    let list: Vec<String> = ids.into_iter().map(|v| qb.text(v)).collect();
                    clauses.push(format!("account_id IN ({})", list.join(", ")));
                    continue;
                }
            }
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

pub struct Built {
    pub sql: String,
    pub params: Vec<duckdb::types::Value>,
}

pub struct QueryArgs<'a> {
    pub dims: &'a Dimensions,
    pub source: &'a str,
    pub exclusions: &'a [String],
    pub account_reverse: Option<&'a HashMap<String, Vec<String>>>,
}

pub fn cost_query(
    group_by: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    a: &QueryArgs,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let group = resolve_field(group_by, a.dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let mut qb = Qb::new();
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'")];
    wheres.extend(filter_clauses(filters, a.dims, a.account_reverse, &mut qb));
    wheres.extend(a.exclusions.iter().cloned());
    let sql = format!(
        "WITH base AS (\n  SELECT {ge} AS entity, service, SUM(cost) AS cost\n  FROM {src}\n  WHERE {w}\n  GROUP BY entity, service\n),\n\
         top_services AS (SELECT service FROM base GROUP BY service ORDER BY SUM(cost) DESC LIMIT 5),\n\
         entity_totals AS (SELECT entity, SUM(cost) AS total_cost FROM base GROUP BY entity)\n\
         SELECT et.entity, CAST(et.total_cost AS DOUBLE) AS total_cost, b.service, CAST(COALESCE(b.cost, 0) AS DOUBLE) AS service_cost\n\
         FROM entity_totals et\n  LEFT JOIN base b ON et.entity = b.entity AND b.service IN (SELECT service FROM top_services)\n  ORDER BY et.total_cost DESC",
        ge = group.field_expr, src = a.source, w = wheres.join(" AND "),
    );
    Ok(Built { sql, params: qb.params })
}

pub fn daily_costs_query(
    group_by: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    a: &QueryArgs,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let group = resolve_field(group_by, a.dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let mut qb = Qb::new();
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'")];
    wheres.extend(filter_clauses(filters, a.dims, a.account_reverse, &mut qb));
    wheres.extend(a.exclusions.iter().cloned());
    let sql = format!(
        "SELECT usage_date::VARCHAR AS date, {ge} AS group_name, CAST(SUM(cost) AS DOUBLE) AS cost\n\
         FROM {src}\n  WHERE {w}\n  GROUP BY date, group_name\n  ORDER BY date, cost DESC",
        ge = group.field_expr, src = a.source, w = wheres.join(" AND "),
    );
    Ok(Built { sql, params: qb.params })
}

pub fn trend_periods(data_dir: &str, start: &str, end: &str) -> Vec<String> {
    let start_d = date_to_days(start);
    let end_d = date_to_days(end);
    let duration = (end_d - start_d) + 1;
    let prev_start = days_to_date(start_d - duration);
    let required = compute_periods_in_range(&prev_start, end);
    let local = list_local_months(data_dir, "daily");
    required.into_iter().filter(|p| local.contains(p)).collect()
}

pub fn trend_query(
    group_by: &str,
    start: &str,
    end: &str,
    delta_threshold: f64,
    filters: &serde_json::Map<String, serde_json::Value>,
    a: &QueryArgs,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let group = resolve_field(group_by, a.dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let mut qb = Qb::new();
    let mut filt = filter_clauses(filters, a.dims, a.account_reverse, &mut qb);
    filt.extend(a.exclusions.iter().cloned());
    let filt_where = if filt.is_empty() { String::new() } else { format!(" AND {}", filt.join(" AND ")) };
    let delta = if delta_threshold.is_finite() && delta_threshold >= 0.0 { delta_threshold } else { 0.0 };
    let sql = format!(
        "WITH bucketed AS (\n  SELECT {ge} AS entity,\n    \
         CASE WHEN usage_date BETWEEN '{start}' AND '{end}' THEN 'current' ELSE 'previous' END AS period,\n    cost\n  \
         FROM {src}\n  WHERE usage_date BETWEEN\n    \
         CAST('{start}' AS DATE) - (DATEDIFF('day', CAST('{start}' AS DATE), CAST('{end}' AS DATE)) + 1) * INTERVAL '1 day'\n    \
         AND '{end}'{filt_where}\n),\n\
         agg AS (\n  SELECT entity,\n    SUM(CASE WHEN period = 'current' THEN cost ELSE 0 END) AS current_cost,\n    \
         SUM(CASE WHEN period = 'previous' THEN cost ELSE 0 END) AS previous_cost\n  FROM bucketed\n  GROUP BY entity\n)\n\
         SELECT entity, CAST(current_cost AS DOUBLE) AS current_cost, CAST(previous_cost AS DOUBLE) AS previous_cost,\n    \
         CAST(current_cost - previous_cost AS DOUBLE) AS delta,\n    \
         CASE WHEN previous_cost = 0 THEN NULL ELSE (current_cost - previous_cost) / previous_cost * 100 END AS percent_change\n  \
         FROM agg\n  WHERE ABS(current_cost - previous_cost) >= {delta}\n  ORDER BY ABS(current_cost - previous_cost) DESC",
        ge = group.field_expr, src = a.source,
    );
    Ok(Built { sql, params: qb.params })
}

pub fn entity_detail_query(
    dimension: &str,
    entity: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    a: &QueryArgs,
) -> Result<Built, String> {
    let start = assert_date(start)?;
    let end = assert_date(end)?;
    let dim = resolve_field(dimension, a.dims).ok_or_else(|| format!("unknown dimension {dimension:?}"))?;
    let mut qb = Qb::new();
    // account entity is a display name → expand to ids
    let entity_clause = if dim.raw_field == "account_id" {
        if let Some(ids) = a.account_reverse.and_then(|r| r.get(entity)) {
            let list: Vec<String> = ids.iter().map(|id| qb.text(id.clone())).collect();
            format!("account_id IN ({})", list.join(", "))
        } else {
            format!("{} = {}", dim.field_expr, qb.text(entity.to_string()))
        }
    } else {
        format!("{} = {}", dim.field_expr, qb.text(entity.to_string()))
    };
    let mut wheres = vec![format!("usage_date BETWEEN '{start}' AND '{end}'"), entity_clause];
    wheres.extend(filter_clauses(filters, a.dims, a.account_reverse, &mut qb));
    wheres.extend(a.exclusions.iter().cloned());
    let sql = format!(
        "SELECT usage_date::VARCHAR AS usage_date, service, account_id, account_name, CAST(SUM(cost) AS DOUBLE) AS cost\n\
         FROM {src}\n  WHERE {w}\n  GROUP BY usage_date, service, account_id, account_name\n  ORDER BY usage_date, cost DESC",
        src = a.source, w = wheres.join(" AND "),
    );
    Ok(Built { sql, params: qb.params })
}

pub fn filter_values_query(
    dim_id: &str,
    start: &str,
    end: &str,
    filters: &serde_json::Map<String, serde_json::Value>,
    a: &QueryArgs,
) -> Result<Built, String> {
    let field_expr = resolve_field_or_column(dim_id, a.dims).ok_or_else(|| format!("unknown dimension {dim_id:?}"))?;
    let mut qb = Qb::new();
    let mut wheres = filter_clauses(filters, a.dims, a.account_reverse, &mut qb);
    wheres.extend(a.exclusions.iter().cloned());
    if valid_date(start) && valid_date(end) {
        wheres.push(format!("usage_date BETWEEN '{start}' AND '{end}'"));
    }
    let sql = format!(
        "SELECT {field_expr} AS val, CAST(SUM(cost) AS DOUBLE) AS total_cost, CAST(COUNT(*) AS DOUBLE) AS row_count\n\
         FROM {src}\n  {w}\n  GROUP BY val\n  HAVING val IS NOT NULL AND val != ''\n  ORDER BY total_cost DESC\n  LIMIT 500",
        src = a.source, w = where_str(&wheres),
    );
    Ok(Built { sql, params: qb.params })
}
