//! Peer data-sharing — the byte-faithful, transport-independent layer ported
//! from `handlers/data-sharing.ts`: Ed25519 identity, the `CGSHARE1-` invite
//! key, the signed pack manifest, and pack-path safety.
//!
//! NOT ported: the TLS-PSK P2P transport (server + client). The protocol pins
//! `ECDHE-PSK-CHACHA20-POLY1305` over TLS 1.2 with a `pskCallback`, which Node
//! has natively (OpenSSL) but Rust's rustls does not reliably support —
//! faithful Electron interop would require the heavy `openssl` native crate.
//! That transport is the one documented gap (see specs/rust-tauri-migration.md);
//! everything an endpoint signs/verifies/encodes lives here and is unit-tested.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const SHARING_KEY_PREFIX: &str = "CGSHARE1-";
pub const SHARING_KEY_VERSION: i64 = 1;
pub const SHARING_PORT: u16 = 53178;
pub const PSK_IDENTITY: &str = "costgoblin";
pub const PACK_MANIFEST_VERSION: i64 = 1;

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
fn unb64(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(s).map_err(|e| format!("base64url: {e}"))
}

// --- Ed25519 identity ---

pub struct Identity {
    pub signing: SigningKey,
}

impl Identity {
    pub fn generate() -> Self {
        Identity { signing: SigningKey::generate(&mut rand::rngs::OsRng) }
    }
    /// 32-byte seed, base64url — the spike's private-key persistence form. (The
    /// Electron protocol stores PKCS#8 PEM; both round-trip the same key bytes.)
    pub fn private_b64(&self) -> String {
        b64(self.signing.to_bytes().as_slice())
    }
    pub fn from_private_b64(s: &str) -> Result<Self, String> {
        let bytes = unb64(s)?;
        let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| "private key must be 32 bytes".to_string())?;
        Ok(Identity { signing: SigningKey::from_bytes(&arr) })
    }
    pub fn public_b64(&self) -> String {
        b64(self.signing.verifying_key().to_bytes().as_slice())
    }
    pub fn sign(&self, msg: &[u8]) -> String {
        b64(self.signing.sign(msg).to_bytes().as_slice())
    }
}

/// Verify a base64url Ed25519 signature against a base64url public key.
pub fn verify(public_b64: &str, msg: &[u8], sig_b64: &str) -> bool {
    let Ok(pk_bytes) = unb64(public_b64) else { return false };
    let Ok(pk_arr): Result<[u8; 32], _> = pk_bytes.as_slice().try_into() else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else { return false };
    let Ok(sig_bytes) = unb64(sig_b64) else { return false };
    let Ok(sig_arr): Result<[u8; 64], _> = sig_bytes.as_slice().try_into() else { return false };
    vk.verify(msg, &Signature::from_bytes(&sig_arr)).is_ok()
}

/// Out-of-band fingerprint: first 16 hex chars of sha256(pubkey), dash-grouped.
pub fn fingerprint(public_b64: &str) -> String {
    let bytes = unb64(public_b64).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(&bytes);
    let hex: String = h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join("-")
}

// --- CGSHARE1 invite key ---

#[derive(Serialize, Deserialize, Clone)]
pub struct SharingKeyPayload {
    pub v: i64,
    pub hosts: Vec<String>,
    pub port: u16,
    pub pub_: String,
    pub psk: String,
    pub label: String,
}

// serde rename so the JSON field is `pub` (a Rust keyword) like the TS payload.
impl SharingKeyPayload {
    fn to_json(&self) -> Value {
        serde_json::json!({ "v": self.v, "hosts": self.hosts, "port": self.port, "pub": self.pub_, "psk": self.psk, "label": self.label })
    }
}

pub fn encode_sharing_key(p: &SharingKeyPayload) -> String {
    let json = serde_json::to_string(&p.to_json()).unwrap_or_default();
    format!("{SHARING_KEY_PREFIX}{}", b64(json.as_bytes()))
}

pub fn parse_sharing_key(key: &str) -> Result<SharingKeyPayload, String> {
    let body = key.strip_prefix(SHARING_KEY_PREFIX).ok_or("not a CostGoblin sharing key")?;
    let bytes = unb64(body)?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("corrupt sharing key: {e}"))?;
    if v.get("v").and_then(|x| x.as_i64()) != Some(SHARING_KEY_VERSION) {
        return Err("unsupported sharing-key version".to_string());
    }
    let hosts: Vec<String> = v.get("hosts").and_then(|h| h.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    if hosts.is_empty() {
        return Err("sharing key has no hosts".to_string());
    }
    let port = v.get("port").and_then(|x| x.as_u64()).filter(|p| *p >= 1 && *p <= 65535).ok_or("invalid port")? as u16;
    let pub_ = v.get("pub").and_then(|x| x.as_str()).ok_or("missing publisher key")?.to_string();
    if unb64(&pub_).map(|b| b.len()).unwrap_or(0) != 32 {
        return Err("invalid publisher key".to_string());
    }
    let psk = v.get("psk").and_then(|x| x.as_str()).ok_or("missing psk")?.to_string();
    if unb64(&psk).map(|b| b.len()).unwrap_or(0) < 16 {
        return Err("psk has insufficient entropy".to_string());
    }
    let label = v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if label.is_empty() || label.len() > 200 {
        return Err("label must be 1-200 chars".to_string());
    }
    Ok(SharingKeyPayload { v: SHARING_KEY_VERSION, hosts, port, pub_, psk, label })
}

// --- signed pack manifest ---

/// Deterministic JSON (recursive key sort, compact) for signing — matches the
/// shape `stableStringify` produces so signatures are reproducible.
pub fn stable_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(a) => format!("[{}]", a.iter().map(stable_stringify).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            format!("{{{}}}", keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), stable_stringify(&o[*k]))).collect::<Vec<_>>().join(","))
        }
    }
}

pub fn sign_manifest(manifest: &Value, id: &Identity) -> Value {
    let sig = id.sign(stable_stringify(manifest).as_bytes());
    serde_json::json!({ "manifest": manifest, "signature": sig })
}

pub fn verify_manifest(signed: &Value) -> bool {
    let Some(manifest) = signed.get("manifest") else { return false };
    let Some(sig) = signed.get("signature").and_then(|s| s.as_str()) else { return false };
    let Some(publisher) = manifest.get("publisher").and_then(|p| p.as_str()) else { return false };
    verify(publisher, stable_stringify(manifest).as_bytes(), sig)
}

/// `aws/raw/{tier}-YYYY-MM[-DD]/<file>.parquet`, no traversal.
pub fn is_safe_pack_path(path: &str) -> bool {
    if path.contains("..") {
        return false;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 4 || parts[0] != "aws" || parts[1] != "raw" {
        return false;
    }
    let dir = parts[2];
    let file = parts[3];
    let tier_ok = ["daily", "hourly", "cost-opt"].iter().any(|t| {
        dir.strip_prefix(&format!("{t}-")).map(|rest| {
            let p: Vec<&str> = rest.split('-').collect();
            (p.len() == 2 || p.len() == 3) && p.iter().all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()))
        }).unwrap_or(false)
    });
    tier_ok && file.ends_with(".parquet") && file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_sign_verify_roundtrips() {
        let id = Identity::generate();
        let msg = b"hello costgoblin";
        let sig = id.sign(msg);
        assert!(verify(&id.public_b64(), msg, &sig));
        assert!(!verify(&id.public_b64(), b"tampered", &sig));
        // private key round-trips
        let id2 = Identity::from_private_b64(&id.private_b64()).unwrap();
        assert_eq!(id2.public_b64(), id.public_b64());
        assert!(verify(&id.public_b64(), msg, &id2.sign(msg)));
    }

    #[test]
    fn sharing_key_roundtrips() {
        let id = Identity::generate();
        let p = SharingKeyPayload {
            v: SHARING_KEY_VERSION,
            hosts: vec!["192.168.1.20".into(), "host.local".into()],
            port: SHARING_PORT,
            pub_: id.public_b64(),
            psk: b64(&[7u8; 24]),
            label: "Etienne's CostGoblin".into(),
        };
        let key = encode_sharing_key(&p);
        assert!(key.starts_with(SHARING_KEY_PREFIX));
        let back = parse_sharing_key(&key).unwrap();
        assert_eq!(back.hosts, p.hosts);
        assert_eq!(back.port, SHARING_PORT);
        assert_eq!(back.pub_, p.pub_);
        assert_eq!(back.label, p.label);
        // rejects junk + short psk
        assert!(parse_sharing_key("nope").is_err());
        let bad = SharingKeyPayload { psk: b64(&[1u8; 4]), ..p.clone() };
        assert!(parse_sharing_key(&encode_sharing_key(&bad)).is_err());
    }

    #[test]
    fn manifest_sign_verify() {
        let id = Identity::generate();
        let manifest = json!({
            "v": PACK_MANIFEST_VERSION,
            "createdAt": "2026-06-15T00:00:00Z",
            "publisher": id.public_b64(),
            "label": "Etienne",
            "files": [{ "path": "aws/raw/daily-2026-04/x.parquet", "size": 10, "sha256": "ab" }],
        });
        let signed = sign_manifest(&manifest, &id);
        assert!(verify_manifest(&signed));
        // tamper the manifest → verification fails
        let mut tampered = signed.clone();
        tampered["manifest"]["label"] = json!("Mallory");
        assert!(!verify_manifest(&tampered));
    }

    #[test]
    fn pack_path_safety() {
        assert!(is_safe_pack_path("aws/raw/daily-2026-04/sb-00001.parquet"));
        assert!(is_safe_pack_path("aws/raw/cost-opt-2026-04-08/data.parquet"));
        assert!(!is_safe_pack_path("aws/raw/daily-2026-04/../../etc/passwd"));
        assert!(!is_safe_pack_path("etc/passwd"));
        assert!(!is_safe_pack_path("aws/raw/daily-2026-04/x.txt"));
    }
}
