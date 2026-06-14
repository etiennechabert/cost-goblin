//! Thin DuckDB helpers. A fresh in-memory connection is opened per query —
//! cheap (~ms) and naturally concurrent across Tauri command threads, since
//! the real cost is `read_parquet` over the fixture files either way.

use duckdb::types::Value as DV;
use duckdb::{params_from_iter, Connection, Row};

pub fn open() -> Result<Connection, String> {
    Connection::open_in_memory().map_err(|e| format!("duckdb open failed: {e}"))
}

/// Accumulates `?` placeholders + bound values, mirroring core's QueryBuilder.
#[derive(Default)]
pub struct Qb {
    pub params: Vec<DV>,
}

impl Qb {
    pub fn new() -> Self {
        Self { params: Vec::new() }
    }
    /// Bind a value and return its `?` placeholder.
    pub fn add(&mut self, v: DV) -> String {
        self.params.push(v);
        "?".to_string()
    }
    pub fn text(&mut self, s: impl Into<String>) -> String {
        self.add(DV::Text(s.into()))
    }
}

/// Run a parameterized query, mapping each row with `f`.
pub fn query_map<T>(
    conn: &Connection,
    sql: &str,
    params: &[DV],
    mut f: impl FnMut(&Row) -> T,
) -> Result<Vec<T>, String> {
    let id = crate::querylog::start(sql, params.len());
    let mut run = || -> Result<Vec<T>, String> {
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("prepare failed: {e}\nSQL: {sql}"))?;
        let mut rows = stmt
            .query(params_from_iter(params.iter()))
            .map_err(|e| format!("query failed: {e}\nSQL: {sql}"))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("row fetch failed: {e}"))? {
            out.push(f(row));
        }
        Ok(out)
    };
    match run() {
        Ok(out) => {
            crate::querylog::complete(id, out.len());
            Ok(out)
        }
        Err(e) => {
            crate::querylog::fail(id, &e);
            Err(e)
        }
    }
}

/// Read a column as f64. NULL or unexpected type → 0.0. All numeric outputs in
/// our SQL are `CAST(... AS DOUBLE)` so this stays lossless.
pub fn f64_at(row: &Row, i: usize) -> f64 {
    row.get::<usize, Option<f64>>(i).ok().flatten().unwrap_or(0.0)
}

/// Read a column as String. NULL → "".
pub fn str_at(row: &Row, i: usize) -> String {
    row.get::<usize, Option<String>>(i)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Read a column as bool. NULL/other → false.
pub fn bool_at(row: &Row, i: usize) -> bool {
    row.get::<usize, Option<bool>>(i).ok().flatten().unwrap_or(false)
}
