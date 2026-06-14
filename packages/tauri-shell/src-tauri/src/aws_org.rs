//! Real AWS Organizations sync via aws-sdk-organizations (read-only), ported
//! from the desktop `aws-org-client.ts`. Resolves credentials from the named
//! profile (SSO supported via aws-config). Writes org-accounts.json (+ the flat
//! org-account-tags.json the query join reads), matching the desktop shapes.

use aws_sdk_organizations::config::Region;
use aws_sdk_organizations::Client;
use aws_smithy_types::date_time::Format;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;

fn now_iso() -> String {
    aws_smithy_types::DateTime::from(std::time::SystemTime::now())
        .fmt(Format::DateTime)
        .unwrap_or_default()
}

struct Acct {
    id: String,
    name: String,
    email: String,
    status: String,
    joined: String,
}

struct Ou {
    name: String,
    parent: String,
}

/// Full read-only Organizations traversal → org-accounts.json. Returns the
/// OrgSyncResult JSON ({ accounts, orgId, syncedAt }).
pub async fn sync(profile: &str, data_dir: &Path) -> Result<Value, String> {
    // Organizations is a global service; force its home region regardless of the
    // profile's region. SSO/static creds resolve from the named profile.
    let conf = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .profile_name(profile.to_string())
        .region(Region::new("us-east-1"))
        .load()
        .await;
    let client = Client::new(&conf);

    let org = client
        .describe_organization()
        .send()
        .await
        .map_err(|e| {
            format!(
                "describe_organization failed (check `aws sso login --profile {profile}`): {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            )
        })?;
    let org_id = org.organization().and_then(|o| o.id()).unwrap_or("unknown").to_string();

    // 1) all accounts
    let mut accounts: Vec<Acct> = vec![];
    let mut tok: Option<String> = None;
    loop {
        let r = client
            .list_accounts()
            .set_next_token(tok.clone())
            .send()
            .await
            .map_err(|e| format!("list_accounts failed: {e}"))?;
        for a in r.accounts() {
            accounts.push(Acct {
                id: a.id().unwrap_or_default().to_string(),
                name: a.name().unwrap_or_default().to_string(),
                email: a.email().unwrap_or_default().to_string(),
                status: a.status().map(|s| s.as_str().to_string()).unwrap_or_else(|| "UNKNOWN".into()),
                joined: a.joined_timestamp().and_then(|d| d.fmt(Format::DateTime).ok()).unwrap_or_default(),
            });
        }
        match r.next_token() {
            Some(t) => tok = Some(t.to_string()),
            None => break,
        }
    }

    // 2) root id
    let roots = client.list_roots().send().await.map_err(|e| format!("list_roots failed: {e}"))?;
    let root_id = roots.roots().first().and_then(|r| r.id()).unwrap_or_default().to_string();

    // 3) OU tree (BFS from root)
    let mut ou_map: HashMap<String, Ou> = HashMap::new();
    let mut queue: Vec<String> = vec![root_id.clone()];
    while let Some(parent) = queue.pop() {
        let mut t: Option<String> = None;
        loop {
            let r = client
                .list_organizational_units_for_parent()
                .parent_id(&parent)
                .set_next_token(t.clone())
                .send()
                .await
                .map_err(|e| format!("list_organizational_units_for_parent failed: {e}"))?;
            for ou in r.organizational_units() {
                if let Some(id) = ou.id() {
                    ou_map.insert(id.to_string(), Ou { name: ou.name().unwrap_or_default().to_string(), parent: parent.clone() });
                    queue.push(id.to_string());
                }
            }
            match r.next_token() {
                Some(n) => t = Some(n.to_string()),
                None => break,
            }
        }
    }

    // 4) account -> parent map
    let mut acct_parent: HashMap<String, String> = HashMap::new();
    let parents: Vec<String> = std::iter::once(root_id.clone()).chain(ou_map.keys().cloned()).collect();
    for parent in &parents {
        let mut t: Option<String> = None;
        loop {
            let r = client
                .list_accounts_for_parent()
                .parent_id(parent)
                .set_next_token(t.clone())
                .send()
                .await
                .map_err(|e| format!("list_accounts_for_parent failed: {e}"))?;
            for a in r.accounts() {
                if let Some(id) = a.id() {
                    acct_parent.insert(id.to_string(), parent.clone());
                }
            }
            match r.next_token() {
                Some(n) => t = Some(n.to_string()),
                None => break,
            }
        }
    }

    let ou_path = |acct_id: &str| -> String {
        let mut parts: Vec<String> = vec![];
        let mut cur = acct_parent.get(acct_id).cloned();
        while let Some(c) = cur {
            if c == root_id {
                break;
            }
            match ou_map.get(&c) {
                Some(ou) => {
                    parts.insert(0, ou.name.clone());
                    cur = Some(ou.parent.clone());
                }
                None => break,
            }
        }
        parts.join(" / ")
    };

    // 5) per-account tags + assemble
    let mut accounts_json: Vec<Value> = vec![];
    let mut flat: Vec<Value> = vec![];
    for a in &accounts {
        let mut tags = Map::new();
        let mut t: Option<String> = None;
        loop {
            match client.list_tags_for_resource().resource_id(&a.id).set_next_token(t.clone()).send().await {
                Ok(r) => {
                    for tag in r.tags() {
                        tags.insert(tag.key().to_string(), json!(tag.value()));
                    }
                    match r.next_token() {
                        Some(n) => t = Some(n.to_string()),
                        None => break,
                    }
                }
                Err(_) => break, // tolerate per-account tag failures (matches desktop)
            }
        }
        let path = ou_path(&a.id);
        accounts_json.push(json!({
            "id": a.id, "name": a.name, "email": a.email, "status": a.status,
            "joinedTimestamp": a.joined, "ouPath": path, "tags": Value::Object(tags.clone()),
        }));
        flat.push(json!({ "id": a.id, "tags": Value::Object(tags), "ouPath": path }));
    }

    let result = json!({ "accounts": accounts_json, "orgId": org_id, "syncedAt": now_iso() });

    // write next to the data dir (userData root), backing up the existing file.
    let base = data_dir.parent().ok_or("data dir has no parent")?;
    let oa = base.join("org-accounts.json");
    if oa.exists() {
        let _ = std::fs::copy(&oa, base.join("org-accounts.json.bak"));
    }
    std::fs::write(&oa, serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write org-accounts.json: {e}"))?;
    std::fs::write(base.join("org-account-tags.json"), serde_json::to_string(&Value::Array(flat)).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write org-account-tags.json: {e}"))?;

    Ok(result)
}

/// Read the persisted org-accounts.json → OrgSyncResult JSON, or Null.
pub fn read_result(data_dir: &Path) -> Value {
    let Some(base) = data_dir.parent() else { return Value::Null };
    let Ok(raw) = std::fs::read_to_string(base.join("org-accounts.json")) else { return Value::Null };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return Value::Null };
    let accounts = v.get("accounts").cloned().unwrap_or_else(|| json!([]));
    if accounts.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        return Value::Null;
    }
    json!({
        "accounts": accounts,
        "orgId": v.get("orgId").cloned().unwrap_or_else(|| json!("")),
        "syncedAt": v.get("syncedAt").cloned().unwrap_or_else(|| json!("")),
    })
}
