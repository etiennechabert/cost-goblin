//! Minimal MCP server (JSON-RPC over HTTP, token-authed, loopback-only) backed
//! by the ported query layer — mirrors `packages/mcp` (an HTTP MCP server in the
//! Electron main). Demonstrates the MCP server is portable to the Rust backend;
//! a production port would use the `rmcp` crate for full streamable-HTTP/SSE.

use crate::{commands, db, query};
use serde_json::{json, Value as J};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const PORT: u16 = 19532;

struct ServerState {
    running: Arc<AtomicBool>,
}

static STATE: OnceLock<Mutex<Option<ServerState>>> = OnceLock::new();
static TOKEN: OnceLock<Mutex<String>> = OnceLock::new();

fn state() -> &'static Mutex<Option<ServerState>> {
    STATE.get_or_init(|| Mutex::new(None))
}

fn token_file(data_dir: &str) -> PathBuf {
    Path::new(data_dir).parent().unwrap_or(Path::new("/")).join("mcp-auth-token")
}

fn rand_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn get_token(data_dir: &str) -> String {
    let cell = TOKEN.get_or_init(|| {
        let path = token_file(data_dir);
        let tok = std::fs::read_to_string(&path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let t = rand_hex(24);
                let _ = std::fs::write(&path, &t);
                t
            });
        Mutex::new(tok)
    });
    cell.lock().unwrap().clone()
}

pub fn regenerate_token(data_dir: &str) -> String {
    let t = rand_hex(24);
    let _ = std::fs::write(token_file(data_dir), &t);
    *TOKEN.get_or_init(|| Mutex::new(String::new())).lock().unwrap() = t.clone();
    t
}

pub fn is_running() -> bool {
    state().lock().unwrap().as_ref().map(|s| s.running.load(Ordering::SeqCst)).unwrap_or(false)
}

pub fn stop() {
    if let Some(s) = state().lock().unwrap().take() {
        s.running.store(false, Ordering::SeqCst);
    }
}

pub fn start(data_dir: String, config_dir: PathBuf) -> Result<(), String> {
    let mut guard = state().lock().unwrap();
    if guard.as_ref().map(|s| s.running.load(Ordering::SeqCst)).unwrap_or(false) {
        return Ok(());
    }
    let token = get_token(&data_dir);
    let server = tiny_http::Server::http(("127.0.0.1", PORT)).map_err(|e| format!("mcp listen :{PORT}: {e}"))?;
    let running = Arc::new(AtomicBool::new(true));
    let r2 = running.clone();
    std::thread::spawn(move || {
        while r2.load(Ordering::SeqCst) {
            match server.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(Some(req)) => handle(req, &data_dir, &config_dir, &token),
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    *guard = Some(ServerState { running });
    Ok(())
}

// --- HTTP / JSON-RPC plumbing ---

fn header<'a>(req: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

fn respond_json(req: tiny_http::Request, status: u16, body: J) {
    let ct = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body.to_string()).with_status_code(status).with_header(ct));
}

fn extract_token(req: &tiny_http::Request) -> Option<String> {
    if let Some(auth) = header(req, "authorization") {
        if let Some(rest) = auth.trim().strip_prefix("Bearer ").or_else(|| auth.trim().strip_prefix("bearer ")) {
            return Some(rest.trim().to_string());
        }
    }
    let url = req.url();
    if let Some(q) = url.split('?').nth(1) {
        for kv in q.split('&') {
            if let Some(v) = kv.strip_prefix("token=") {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn handle(mut req: tiny_http::Request, data_dir: &str, config_dir: &Path, token: &str) {
    // DNS-rebinding guard: loopback Host only.
    let host_ok = header(&req, "host").map(|h| {
        let h = h.to_lowercase();
        h.starts_with("127.0.0.1") || h.starts_with("localhost") || h.starts_with("[::1]")
    }).unwrap_or(false);
    if !host_ok {
        respond_json(req, 403, json!({"jsonrpc":"2.0","error":{"code":-32000,"message":"Forbidden: invalid Host"},"id":null}));
        return;
    }
    let path = req.url().split('?').next().unwrap_or("").to_string();
    if path == "/health" {
        respond_json(req, 200, json!({"status":"ok"}));
        return;
    }
    if path != "/mcp" {
        respond_json(req, 404, json!({"error":"not found"}));
        return;
    }
    if extract_token(&req).as_deref() != Some(token) {
        respond_json(req, 401, json!({"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}));
        return;
    }
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let parsed: J = serde_json::from_str(&body).unwrap_or(J::Null);
    let id = parsed.get("id").cloned().unwrap_or(J::Null);
    let method = parsed.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = parsed.get("params").cloned().unwrap_or(J::Null);

    // notifications carry no id and expect no JSON-RPC response body.
    if method.starts_with("notifications/") {
        respond_json(req, 202, J::Null);
        return;
    }

    let result: Result<J, String> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "costgoblin", "version": "0.1.0-tauri-spike" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => call_tool(&params, data_dir, config_dir),
        other => Err(format!("unknown method: {other}")),
    };

    match result {
        Ok(r) => respond_json(req, 200, json!({"jsonrpc":"2.0","id":id,"result":r})),
        Err(e) => respond_json(req, 200, json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":e}})),
    }
}

// --- tools ---

fn date_default() -> (String, String) {
    let now = query::epoch_days_now();
    (query::days_to_date(now - 2 - 29), query::days_to_date(now - 2))
}

fn parse_range(args: &J) -> (String, String) {
    let dr = args.get("dateRange");
    let s = dr.and_then(|d| d.get("start")).and_then(|v| v.as_str());
    let e = dr.and_then(|d| d.get("end")).and_then(|v| v.as_str());
    match (s, e) {
        (Some(s), Some(e)) if query::valid_date(s) && query::valid_date(e) => (s.to_string(), e.to_string()),
        _ => date_default(),
    }
}

/// cost grouped by a dimension over a date range → [(entity, total)], account
/// ids mapped to display names. Reuses the full request context (metric +
/// cost-scope exclusions + org join).
fn cost_by_dim(dd: &str, cd: &Path, group_by: &str, start: &str, end: &str, limit: usize) -> Result<Vec<(String, f64)>, String> {
    if !query::valid_date(start) || !query::valid_date(end) {
        return Err("invalid date".into());
    }
    let ctx = commands::req_ctx_from(dd, cd)?;
    let periods = query::available_periods(dd, "daily", start, end);
    if periods.is_empty() {
        return Ok(vec![]);
    }
    let source = ctx.source(dd, "daily", &periods, &ctx.metric, ctx.net);
    let resolved = query::resolve_field(group_by, &ctx.dims).ok_or_else(|| format!("unknown dimension {group_by:?}"))?;
    let excl = if ctx.exclusions.is_empty() { String::new() } else { format!(" AND {}", ctx.exclusions.join(" AND ")) };
    let sql = format!(
        "SELECT {} AS entity, CAST(SUM(cost) AS DOUBLE) AS total FROM {} WHERE usage_date BETWEEN '{}' AND '{}'{} GROUP BY entity HAVING entity IS NOT NULL AND entity != '' ORDER BY total DESC LIMIT {}",
        resolved.field_expr, source, start, end, excl, limit * 4
    );
    let conn = db::open()?;
    let rows = db::query_map(&conn, &sql, &[], |r| (db::str_at(r, 0), db::f64_at(r, 1)))?;
    if ctx.is_account_group(group_by) {
        let mut m: HashMap<String, f64> = HashMap::new();
        let mut order: Vec<String> = vec![];
        for (id, t) in rows {
            let n = ctx.map_account(&id);
            if !m.contains_key(&n) {
                order.push(n.clone());
            }
            *m.entry(n).or_insert(0.0) += t;
        }
        let mut v: Vec<(String, f64)> = order.into_iter().map(|n| (n.clone(), m[&n])).collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.truncate(limit);
        Ok(v)
    } else {
        Ok(rows.into_iter().take(limit).collect())
    }
}

fn text_result(value: J) -> J {
    json!({ "content": [ { "type": "text", "text": value.to_string() } ] })
}

fn call_tool(params: &J, dd: &str, cd: &Path) -> Result<J, String> {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(J::Null);
    match name {
        "list_dimensions" => {
            let dims = config_dims(cd)?;
            Ok(text_result(crate::config::dimensions_flat(&dims)))
        }
        "get_cost_overview" => {
            let (start, end) = parse_range(&args);
            let services = cost_by_dim(dd, cd, "service", &start, &end, 10)?;
            let accounts = cost_by_dim(dd, cd, "account", &start, &end, 10)?;
            let total: f64 = cost_by_dim(dd, cd, "service", &start, &end, 100_000)?.iter().map(|(_, c)| c).sum();
            Ok(text_result(json!({
                "dateRange": { "start": start, "end": end },
                "totalCost": total,
                "topServices": services.iter().map(|(n, c)| json!({"name": n, "cost": c})).collect::<Vec<_>>(),
                "topAccounts": accounts.iter().map(|(n, c)| json!({"name": n, "cost": c})).collect::<Vec<_>>(),
            })))
        }
        "query_costs" => {
            let group_by = args.get("groupBy").and_then(|v| v.as_str()).ok_or("query_costs: groupBy required")?;
            let (start, end) = parse_range(&args);
            let rows = cost_by_dim(dd, cd, group_by, &start, &end, 100)?;
            Ok(text_result(json!(rows.iter().map(|(n, c)| json!({"entity": n, "cost": c})).collect::<Vec<_>>())))
        }
        "get_filter_values" => {
            let dim = args.get("dimensionId").and_then(|v| v.as_str()).ok_or("get_filter_values: dimensionId required")?;
            let (start, end) = parse_range(&args);
            let rows = cost_by_dim(dd, cd, dim, &start, &end, 200)?;
            Ok(text_result(json!(rows.iter().map(|(n, c)| json!({"value": n, "cost": c})).collect::<Vec<_>>())))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn config_dims(cd: &Path) -> Result<crate::config::Dimensions, String> {
    crate::config::load_dimensions(cd)
}

fn tool_defs() -> J {
    let date_range = json!({ "type": "object", "properties": { "start": {"type":"string"}, "end": {"type":"string"} } });
    json!([
        { "name": "get_cost_overview", "description": "High-level overview: total spend + top services + top accounts. Start here.",
          "inputSchema": { "type": "object", "properties": { "dateRange": date_range } } },
        { "name": "list_dimensions", "description": "List available cost dimensions (built-ins + tags).",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "query_costs", "description": "Total cost grouped by a dimension over a date range.",
          "inputSchema": { "type": "object", "required": ["groupBy"], "properties": { "groupBy": {"type":"string"}, "dateRange": date_range } } },
        { "name": "get_filter_values", "description": "Distinct values (with cost) for a dimension.",
          "inputSchema": { "type": "object", "required": ["dimensionId"], "properties": { "dimensionId": {"type":"string"}, "dateRange": date_range } } }
    ])
}
