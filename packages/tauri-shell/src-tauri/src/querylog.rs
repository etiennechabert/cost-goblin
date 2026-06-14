//! In-memory query log powering the renderer's Debug panel (mirrors the
//! desktop `main/query-log.ts`). Every DuckDB query run via `db::query_map`
//! records start/complete/fail here; commands expose it to the webview.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CAP: usize = 200;

struct Entry {
    id: i64,
    sql: String,
    param_count: usize,
    status: &'static str,
    started_at: f64,
    duration_ms: Option<f64>,
    row_count: Option<i64>,
    error: Option<String>,
}

struct Inner {
    next: i64,
    items: VecDeque<Entry>,
}

static LOG: OnceLock<Mutex<Inner>> = OnceLock::new();

fn log() -> &'static Mutex<Inner> {
    LOG.get_or_init(|| Mutex::new(Inner { next: 1, items: VecDeque::new() }))
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

pub fn start(sql: &str, param_count: usize) -> i64 {
    let mut g = log().lock().unwrap();
    let id = g.next;
    g.next += 1;
    g.items.push_front(Entry {
        id,
        sql: sql.to_string(),
        param_count,
        status: "running",
        started_at: now_ms(),
        duration_ms: None,
        row_count: None,
        error: None,
    });
    while g.items.len() > CAP {
        g.items.pop_back();
    }
    id
}

pub fn complete(id: i64, row_count: usize) {
    let now = now_ms();
    let mut g = log().lock().unwrap();
    if let Some(e) = g.items.iter_mut().find(|e| e.id == id) {
        e.status = "success";
        e.duration_ms = Some(now - e.started_at);
        e.row_count = Some(row_count as i64);
    }
}

pub fn fail(id: i64, err: &str) {
    let now = now_ms();
    let mut g = log().lock().unwrap();
    if let Some(e) = g.items.iter_mut().find(|e| e.id == id) {
        e.status = "error";
        e.duration_ms = Some(now - e.started_at);
        e.error = Some(err.to_string());
    }
}

pub fn clear() {
    log().lock().unwrap().items.clear();
}

pub fn sql_for(id: i64) -> Option<String> {
    log().lock().unwrap().items.iter().find(|e| e.id == id).map(|e| e.sql.clone())
}

/// JSON array shaped like the renderer's DebugQueryLogEntry (most recent first).
pub fn snapshot() -> Value {
    let g = log().lock().unwrap();
    let items: Vec<Value> = g
        .items
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "sql": e.sql,
                "paramCount": e.param_count,
                "status": e.status,
                "startedAt": e.started_at,
                "durationMs": e.duration_ms,
                "rowCount": e.row_count,
                "error": e.error,
                "materialized": false,
                "cached": false,
                "origin": Value::Null,
            })
        })
        .collect();
    Value::Array(items)
}
