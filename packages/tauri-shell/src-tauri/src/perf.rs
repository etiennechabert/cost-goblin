//! DuckDB performance tuning, ported from `duckdb-tuning.ts`. Applies
//! `SET memory_limit` / `SET threads` to every connection from a process-global
//! cache the user can override via `setPerformanceSettings`.
//!
//! Note on the materialized base: Electron keeps an in-memory `cost_base` table
//! for fast repeat queries. The spike's fast path is the **rollup** instead
//! (pre-aggregated partitions), which supersedes it — so there is no separate
//! in-memory base and `awaitMaterializedBase` returns immediately.

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

pub const MIN_MEMORY_GB: i64 = 1;
pub const MAX_MEMORY_GB: i64 = 24;

/// User overrides (None = auto/default). Resolved values are applied per connection.
fn settings() -> &'static Mutex<(Option<i64>, Option<i64>)> {
    static S: OnceLock<Mutex<(Option<i64>, Option<i64>)>> = OnceLock::new();
    S.get_or_init(|| Mutex::new((None, None)))
}

pub fn total_memory_gb() -> i64 {
    // macOS: hw.memsize (bytes). Falls back to 8 GB if the probe fails.
    let bytes = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    match bytes {
        Some(b) => ((b as f64) / (1024.0 * 1024.0 * 1024.0)).round().max(1.0) as i64,
        None => 8,
    }
}

pub fn max_threads() -> i64 {
    std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(1).max(1)
}

fn total_memory_gb_f() -> f64 {
    let bytes = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    bytes.map(|b| (b as f64) / (1024.0 * 1024.0 * 1024.0)).unwrap_or(8.0)
}

pub fn default_memory_gb() -> i64 {
    (total_memory_gb_f() * 0.5).round().clamp(MIN_MEMORY_GB as f64, MAX_MEMORY_GB as f64) as i64
}
pub fn default_threads() -> i64 {
    max_threads()
}

fn clamp_memory(gb: i64) -> i64 {
    let ceiling = total_memory_gb().clamp(MIN_MEMORY_GB, MAX_MEMORY_GB);
    gb.clamp(MIN_MEMORY_GB, ceiling)
}
fn clamp_threads(n: i64) -> i64 {
    n.clamp(1, max_threads())
}

fn resolve_memory(o: Option<i64>) -> i64 {
    o.map(clamp_memory).unwrap_or_else(default_memory_gb)
}
fn resolve_threads(o: Option<i64>) -> i64 {
    o.map(clamp_threads).unwrap_or_else(default_threads)
}

/// Set the global overrides (None = auto). Called at startup from prefs and by
/// `setPerformanceSettings`.
pub fn set(memory_limit_gb: Option<i64>, threads: Option<i64>) {
    *settings().lock().unwrap() = (memory_limit_gb, threads);
}

/// Apply the resolved memory/threads to a freshly opened connection.
pub fn apply(conn: &duckdb::Connection) {
    let (mem, threads) = *settings().lock().unwrap();
    let mem = resolve_memory(mem);
    let threads = resolve_threads(threads);
    let _ = conn.execute_batch(&format!("SET memory_limit='{mem}GB'; SET threads={threads};"));
}

/// PerformanceInfo for the Settings → Performance panel.
pub fn info() -> Value {
    let (mem, threads) = *settings().lock().unwrap();
    json!({
        "defaultMemoryGB": default_memory_gb(),
        "defaultThreads": default_threads(),
        "totalMemoryGB": total_memory_gb(),
        "maxThreads": max_threads(),
        "minMemoryGB": MIN_MEMORY_GB,
        "maxMemoryGB": MAX_MEMORY_GB,
        "current": { "memoryLimitGB": mem, "threads": threads },
    })
}
