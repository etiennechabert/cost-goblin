// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod db;
mod query;

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
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::get_config,
            commands::get_dimensions,
            commands::get_dimensions_config,
            commands::get_org_tree,
            commands::get_views_config,
            commands::get_cost_scope,
            commands::get_ui_preferences,
            commands::get_explorer_preferences,
            commands::get_data_inventory,
            commands::query_costs,
            commands::query_daily_costs,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod smoke {
    use crate::{config, db, query};
    use std::path::Path;

    fn data_dir() -> String {
        format!("{}/../.fixtures", env!("CARGO_MANIFEST_DIR"))
    }
    fn config_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/src/__fixtures__/config")
    }

    /// End-to-end: load the real dimensions config, build the ported SQL, and
    /// run it through the duckdb crate against the date-shifted fixtures.
    /// Requires `npm run prepare:fixtures` to have populated `.fixtures/`.
    #[test]
    fn queries_return_rows() {
        let dd = data_dir();
        let dims = config::load_dimensions(&config_dir()).expect("load dimensions");
        let months = query::list_local_months(&dd, "daily");
        assert!(!months.is_empty(), "no local months in .fixtures — run prepare:fixtures");
        let start = format!("{}-01", months.first().unwrap());
        let end = format!("{}-28", months.last().unwrap());
        let periods = query::available_periods(&dd, "daily", &start, &end);
        assert!(!periods.is_empty(), "no available periods");
        let source = query::build_source(&dd, "daily", &periods, "unblended", &dims);
        let conn = db::open().unwrap();

        // cost-by-service
        let built = query::cost_query("service", &start, &end, &serde_json::Map::new(), &dims, &source).unwrap();
        let cost_rows = db::query_map(&conn, &built.sql, &built.params, |r| (db::str_at(r, 0), db::f64_at(r, 1))).unwrap();
        assert!(!cost_rows.is_empty(), "cost_query returned no rows");

        // daily-by-service
        let dbuilt = query::daily_costs_query("service", &start, &end, &serde_json::Map::new(), &dims, &source).unwrap();
        let day_rows = db::query_map(&conn, &dbuilt.sql, &dbuilt.params, |r| (db::str_at(r, 0), db::f64_at(r, 2))).unwrap();
        assert!(!day_rows.is_empty(), "daily_costs_query returned no rows");
        let total: f64 = day_rows.iter().map(|(_, c)| c).sum();
        assert!(total > 0.0, "total cost should be > 0");

        // account dimension resolves to account_name (display) and yields rows
        let abuilt = query::cost_query("account", &start, &end, &serde_json::Map::new(), &dims, &source).unwrap();
        let acct_rows = db::query_map(&conn, &abuilt.sql, &abuilt.params, |r| db::str_at(r, 0)).unwrap();
        assert!(acct_rows.iter().any(|e| !e.is_empty()), "account entities should be non-empty names");

        eprintln!(
            "SMOKE OK: months={:?} cost_rows={} day_rows={} total={:.2}",
            months, cost_rows.len(), day_rows.len(), total
        );
    }
}
