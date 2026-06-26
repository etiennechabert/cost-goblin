// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aws_org;
mod aws_ssm;
mod bundle;
mod commands;
mod config;
mod config_write;
mod db;
mod mcp;
mod perf;
mod query;
mod querylog;
mod rollup;
mod sharing;
mod sync;

use commands::AppState;
use std::path::PathBuf;

/// Resolve the fixture data + config dirs. `npm run tauri:dev` sets the env
/// vars (matching Electron's `dev:fixtures`); the fallbacks let `cargo run`
/// work from the manifest dir too.
fn resolve_dirs() -> (String, PathBuf) {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let data_dir = std::env::var("COSTGOBLIN_DATA_DIR").unwrap_or_else(|_| {
        manifest.join("../.fixtures").to_string_lossy().to_string()
    });
    let config_dir = std::env::var("COSTGOBLIN_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join("../../core/src/__fixtures__/config"));
    (data_dir, config_dir)
}

fn main() {
    let (data_dir, config_dir) = resolve_dirs();
    eprintln!("[costgoblin-tauri-spike] data_dir={data_dir}");
    eprintln!("[costgoblin-tauri-spike] config_dir={}", config_dir.display());

    // Apply persisted DuckDB perf overrides (memory/threads) before any query.
    if let Some(base) = std::path::Path::new(&data_dir).parent() {
        if let Ok(s) = std::fs::read_to_string(base.join("app-preferences.json")) {
            if let Ok(p) = serde_json::from_str::<serde_json::Value>(&s) {
                perf::set(p.get("perfMemoryLimitGB").and_then(|v| v.as_i64()), p.get("perfThreads").and_then(|v| v.as_i64()));
            }
        }
    }

    let state = AppState {
        data_dir,
        config_dir,
        app_version: format!("{}-tauri-spike", env!("CARGO_PKG_VERSION")),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::check_for_updates,
            commands::download_update,
            commands::quit_and_install,
            commands::get_query_log,
            commands::clear_query_log,
            commands::run_explain,
            commands::list_aws_profiles,
            commands::sync_org_accounts,
            commands::get_org_sync_result,
            commands::sync_region_names,
            commands::get_region_names_info,
            commands::clear_org_data,
            commands::get_config,
            commands::get_dimensions,
            commands::get_dimensions_config,
            commands::get_org_tree,
            commands::get_views_config,
            commands::get_cost_scope,
            commands::get_ui_preferences,
            commands::save_ui_preferences,
            commands::get_explorer_preferences,
            commands::save_explorer_preferences,
            commands::get_savings_preferences,
            commands::save_savings_preferences,
            commands::save_dimensions_config,
            commands::save_views_config,
            commands::save_cost_scope,
            commands::update_aws_profile,
            commands::open_data_folder,
            commands::reveal_config_folder,
            commands::get_data_inventory,
            commands::sync_periods,
            commands::cancel_sync,
            commands::delete_local_period,
            commands::get_sync_status,
            commands::sso_login,
            commands::prune_now,
            commands::get_auto_prune_enabled,
            commands::set_auto_prune_enabled,
            commands::query_costs,
            commands::query_daily_costs,
            commands::query_savings,
            commands::query_trends,
            commands::query_entity_detail,
            commands::get_filter_values,
            commands::query_explorer_overview,
            commands::query_explorer_rows,
            commands::query_aggregated_table,
            commands::get_explorer_filter_values,
            commands::query_missing_tags,
            commands::discover_tag_keys,
            commands::discover_column_values,
            commands::export_config_bundle,
            commands::preview_config_bundle_file,
            commands::fetch_config_bundle_from_s3,
            commands::apply_config_bundle,
            commands::publish_config_bundle,
            commands::check_config_beacon,
            commands::get_rollup_status,
            commands::get_rollup_stats,
            commands::estimate_rollup_grain,
            commands::build_rollup,
            commands::get_performance_info,
            commands::set_performance_settings,
            commands::await_materialized_base,
            commands::get_mcp_server_running,
            commands::set_mcp_server_running,
            commands::get_mcp_token,
            commands::regenerate_mcp_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod smoke {
    use crate::{config, db, query};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn data_dir() -> String {
        std::env::var("COSTGOBLIN_DATA_DIR")
            .unwrap_or_else(|_| format!("{}/../.fixtures", env!("CARGO_MANIFEST_DIR")))
    }
    fn config_dir() -> PathBuf {
        std::env::var("COSTGOBLIN_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/src/__fixtures__/config"))
    }

    /// Exercises the FULL-fidelity path (cost-scope metric + exclusions +
    /// org-account join + account-name mapping). With no env vars it runs on the
    /// date-shifted fixtures; point COSTGOBLIN_DATA_DIR/CONFIG_DIR at a real
    /// dataset to validate that.
    #[test]
    fn full_fidelity_path_runs() {
        let dd = data_dir();
        let cfg = config_dir();
        let dims = config::load_dimensions(&cfg).expect("load dimensions");
        let cs = config::load_cost_scope(&cfg);
        let metric = config::normalize_metric(&cs.cost_metric);
        let net = cs.cost_perspective.as_deref() == Some("net");
        let exclusions = query::build_exclusion_clauses(&cs, &dims);
        let org_path = config::org_tags_path(Path::new(&dd));
        let name_from_tag = dims.account_built_in().and_then(|b| b.account_name_from_tag.clone());
        let name_map = config::load_account_name_map(Path::new(&dd), name_from_tag.as_deref());
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for (id, n) in &name_map {
            reverse.entry(n.clone()).or_default().push(id.clone());
        }

        let months = query::list_local_months(&dd, "daily");
        assert!(!months.is_empty(), "no daily months on disk at {dd}");
        // last ~30 days within available data
        let end = format!("{}-28", months.last().unwrap());
        let start = format!("{}-01", months.last().unwrap());
        let periods = query::available_periods(&dd, "daily", &start, &end);
        assert!(!periods.is_empty());
        let source = query::build_source(&dd, "daily", &periods, &metric, net, &dims, org_path.as_deref(), &cs.active_marketplace_rules(), &[]);
        let conn = db::open().unwrap();
        let nf = serde_json::Map::new();
        let args = query::QueryArgs { dims: &dims, source: &source, exclusions: &exclusions, account_reverse: Some(&reverse) };

        let svc = query::cost_query("service", &start, &end, &nf, &args).unwrap();
        let svc_rows = db::query_map(&conn, &svc.sql, &svc.params, |r| (db::str_at(r, 0), db::f64_at(r, 1))).unwrap();
        let total: f64 = {
            let mut seen: HashMap<String, f64> = HashMap::new();
            for (e, t) in &svc_rows { seen.entry(e.clone()).or_insert(*t); }
            seen.values().sum()
        };
        assert!(!svc_rows.is_empty(), "no service rows");

        // a tag dim with org fallback (first owner tag), if any
        let owner_tag = dims.tags.iter().find(|t| t.concept.as_deref() == Some("owner")).map(query::tag_dim_column);
        let team_n = if let Some(col) = &owner_tag {
            let q = query::cost_query(col, &start, &end, &nf, &args).unwrap();
            db::query_map(&conn, &q.sql, &q.params, |r| db::str_at(r, 0)).unwrap().len()
        } else { 0 };

        eprintln!(
            "SMOKE OK [{}]: metric={} exclusions={} org_join={} months={:?} services={} window_total={:.2} owner_rows={}",
            dd, metric, exclusions.len(), org_path.is_some(), months, svc_rows.len(), total, team_n,
        );
    }

    /// Builds the rollup from scratch, then asserts it (a) validates under the
    /// live signature, (b) is routed to by rollup_source_validated, and (c)
    /// yields the same cost-overview totals as the raw path. Runs on whatever
    /// COSTGOBLIN_DATA_DIR points at (fixtures by default).
    #[test]
    fn rollup_build_roundtrip() {
        let dd = data_dir();
        let cfg = config_dir();
        let months = query::list_local_months(&dd, "daily");
        if months.is_empty() {
            eprintln!("BUILD ROUNDTRIP: no daily data — skipping");
            return;
        }
        // Build fresh (force so it doesn't carry a pre-existing partition).
        let res = crate::rollup::build_rollup(&dd, &cfg, true).expect("build_rollup");
        eprintln!("BUILD: {res}");

        let dims = config::load_dimensions(&cfg).expect("dims");
        let cs = config::load_cost_scope(&cfg);
        let metric = config::normalize_metric(&cs.cost_metric);
        let net = cs.cost_perspective.as_deref() == Some("net");
        let org_path = config::org_tags_path(Path::new(&dd));
        let name_from_tag = dims.account_built_in().and_then(|b| b.account_name_from_tag.clone());
        let name_map = config::load_account_name_map(Path::new(&dd), name_from_tag.as_deref());
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for (id, n) in &name_map { reverse.entry(n.clone()).or_default().push(id.clone()); }

        let start = format!("{}-01", months.first().unwrap());
        let end = format!("{}-28", months.last().unwrap());
        let periods = query::available_periods(&dd, "daily", &start, &end);
        let needed = vec!["service".to_string(), "cost".to_string()];

        // Freshly built → must validate + route to the rollup.
        let rollup_src = crate::rollup::rollup_source_validated(&dd, &dims, &cs, "daily", &periods, &needed)
            .expect("freshly-built rollup should validate + route");
        let raw_src = query::build_source(&dd, "daily", &periods, &metric, net, &dims, org_path.as_deref(), &cs.active_marketplace_rules(), &[]);

        let conn = db::open().unwrap();
        let nf = serde_json::Map::new();
        let total = |src: &str, excl: &[String]| -> f64 {
            let args = query::QueryArgs { dims: &dims, source: src, exclusions: excl, account_reverse: Some(&reverse) };
            let built = query::cost_query("service", &start, &end, &nf, &args).unwrap();
            let rows = db::query_map(&conn, &built.sql, &built.params, |r| (db::str_at(r, 0), db::f64_at(r, 1))).unwrap();
            let mut seen: HashMap<String, f64> = HashMap::new();
            for (e, t) in &rows { seen.entry(e.clone()).or_insert(*t); }
            seen.values().sum()
        };
        let raw_total = total(&raw_src, &cs_exclusions(&cs, &dims));
        let roll_total = total(&rollup_src, &[]);
        eprintln!("BUILD ROUNDTRIP: raw=${raw_total:.2} rollup=${roll_total:.2}");
        let diff = (raw_total - roll_total).abs();
        let tol = raw_total.abs() * 1e-4 + 0.01;
        assert!(diff <= tol, "rollup total {roll_total} should match raw {raw_total} (diff {diff} > tol {tol})");
    }

    fn cs_exclusions(cs: &config::CostScope, dims: &config::Dimensions) -> Vec<String> {
        query::build_exclusion_clauses(cs, dims)
    }

    /// Rollup-vs-raw latency benchmark for the cost-overview dashboard query
    /// (group by service, full available window). Skips when no rollup is on
    /// disk. Point COSTGOBLIN_DATA_DIR/CONFIG_DIR at a real dataset to measure.
    #[test]
    fn rollup_vs_raw_bench() {
        let dd = data_dir();
        let cfg = config_dir();
        let dims = config::load_dimensions(&cfg).expect("dims");
        let cs = config::load_cost_scope(&cfg);
        let metric = config::normalize_metric(&cs.cost_metric);
        let net = cs.cost_perspective.as_deref() == Some("net");
        let exclusions = query::build_exclusion_clauses(&cs, &dims);
        let org_path = config::org_tags_path(Path::new(&dd));
        let name_from_tag = dims.account_built_in().and_then(|b| b.account_name_from_tag.clone());
        let name_map = config::load_account_name_map(Path::new(&dd), name_from_tag.as_deref());
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for (id, n) in &name_map {
            reverse.entry(n.clone()).or_default().push(id.clone());
        }

        // Window = the months that are actually rolled up (Electron builds the
        // rollup lazily for the hot window), so the query is rollup-eligible.
        let Some(m) = crate::rollup::load_manifest(&dd) else {
            eprintln!("BENCH: no rollup manifest at {dd} — skipping (run Electron 0.4.x to build it)");
            return;
        };
        let rolled: Vec<String> = m.partitions.iter().cloned().collect();
        if rolled.is_empty() {
            eprintln!("BENCH: rollup has no partitions — skipping");
            return;
        }
        let start = format!("{}-01", rolled.first().unwrap());
        let end = format!("{}-28", rolled.last().unwrap());
        let periods = query::available_periods(&dd, "daily", &start, &end);
        let needed = vec!["service".to_string(), "cost".to_string()];
        let Some(rollup_src) = crate::rollup::rollup_source(&dd, "daily", &periods, &needed) else {
            eprintln!("BENCH: window not rollup-eligible — skipping");
            return;
        };
        let raw_src = query::build_source(&dd, "daily", &periods, &metric, net, &dims, org_path.as_deref(), &cs.active_marketplace_rules(), &[]);

        let conn = db::open().unwrap();
        let nf = serde_json::Map::new();
        let run = |src: &str, excl: &[String]| -> (u128, usize, f64) {
            let args = query::QueryArgs { dims: &dims, source: src, exclusions: excl, account_reverse: Some(&reverse) };
            let built = query::cost_query("service", &start, &end, &nf, &args).unwrap();
            let t = std::time::Instant::now();
            let rows = db::query_map(&conn, &built.sql, &built.params, |r| (db::str_at(r, 0), db::f64_at(r, 1))).unwrap();
            let ms = t.elapsed().as_millis();
            let mut seen: HashMap<String, f64> = HashMap::new();
            for (e, tot) in &rows {
                seen.entry(e.clone()).or_insert(*tot);
            }
            let total: f64 = seen.values().sum();
            (ms, seen.len(), total)
        };
        // warm OS page cache + DuckDB metadata, then take best-of-3.
        let _ = run(&raw_src, &exclusions);
        let _ = run(&rollup_src, &[]);
        let (mut raw_ms, mut roll_ms) = (u128::MAX, u128::MAX);
        let (mut raw_n, mut raw_t, mut roll_n, mut roll_t) = (0usize, 0.0, 0usize, 0.0);
        for _ in 0..3 {
            let (m, n, t) = run(&raw_src, &exclusions);
            if m < raw_ms { raw_ms = m; }
            raw_n = n; raw_t = t;
            let (m, n, t) = run(&rollup_src, &[]);
            if m < roll_ms { roll_ms = m; }
            roll_n = n; roll_t = t;
        }
        let st = crate::rollup::stats(&dd);
        eprintln!("BENCH cost-overview(service) over {} months [{start}..{end}]:", periods.len());
        eprintln!("  RAW    : {raw_ms:>5} ms   ({raw_n} services, ${raw_t:.0})");
        eprintln!("  ROLLUP : {roll_ms:>5} ms   ({roll_n} services, ${roll_t:.0})");
        eprintln!("  speedup: {:.1}x", raw_ms as f64 / roll_ms.max(1) as f64);
        eprintln!("  on-disk: rollup {} MB / raw {} MB ({} rollup rows)",
            st.get("rollupBytes").and_then(|v| v.as_u64()).unwrap_or(0) / 1_048_576,
            st.get("rawBytes").and_then(|v| v.as_u64()).unwrap_or(0) / 1_048_576,
            st.get("rollupRows").and_then(|v| v.as_u64()).unwrap_or(0));
    }

    /// Live AWS Organizations sync — opt-in (set CG_LIVE_AWS=1 + CG_PROFILE).
    /// Makes real read-only calls and refreshes org-accounts.json.
    #[test]
    fn org_sync_live() {
        if std::env::var("CG_LIVE_AWS").is_err() {
            eprintln!("org_sync_live: skipped (set CG_LIVE_AWS=1 to run)");
            return;
        }
        let profile = std::env::var("CG_PROFILE").unwrap_or_else(|_| "default".to_string());
        let dd = data_dir();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let r = rt
            .block_on(crate::aws_org::sync(&profile, Path::new(&dd)))
            .expect("org sync failed");
        let n = r["accounts"].as_array().map(|a| a.len()).unwrap_or(0);
        let with_tags = r["accounts"].as_array().map(|a| a.iter().filter(|x| x["tags"].as_object().map(|t| !t.is_empty()).unwrap_or(false)).count()).unwrap_or(0);
        eprintln!("ORG SYNC LIVE OK: {} accounts ({} with tags), orgId={}", n, with_tags, r["orgId"]);
        assert!(n > 0, "expected > 0 accounts");
    }

    /// End-to-end MCP server check: start it, POST a tools/call over HTTP with
    /// the auth token, assert a JSON-RPC result comes back. Runs on whatever
    /// COSTGOBLIN_DATA_DIR points at (fixtures by default).
    #[test]
    fn mcp_server_responds() {
        use std::io::{Read, Write};
        let dd = data_dir();
        crate::mcp::start(dd.clone(), config_dir()).expect("mcp start");
        std::thread::sleep(std::time::Duration::from_millis(600));
        let token = crate::mcp::get_token(&dd);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cost_overview","arguments":{}}}"#;
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:19532\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let mut stream = std::net::TcpStream::connect("127.0.0.1:19532").expect("connect mcp");
        stream.write_all(req.as_bytes()).unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();

        // and a no-token request must be rejected
        let mut s2 = std::net::TcpStream::connect("127.0.0.1:19532").expect("connect mcp 2");
        s2.write_all(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:19532\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        let mut resp2 = String::new();
        s2.read_to_string(&mut resp2).unwrap();
        crate::mcp::stop();

        eprintln!("MCP RESP (tail): {}", &resp[resp.len().saturating_sub(300)..]);
        assert!(resp.contains("\"result\"") && resp.contains("totalCost"), "expected tool result, got: {resp}");
        assert!(resp2.contains("401") || resp2.contains("Unauthorized"), "expected 401 without token, got: {resp2}");
    }
}
