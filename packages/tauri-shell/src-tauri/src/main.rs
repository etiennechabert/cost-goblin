// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aws_org;
mod aws_ssm;
mod commands;
mod config;
mod config_write;
mod db;
mod mcp;
mod query;
mod querylog;

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
        let source = query::build_source(&dd, "daily", &periods, &metric, net, &dims, org_path.as_deref());
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
