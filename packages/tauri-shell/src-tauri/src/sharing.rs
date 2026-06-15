//! Config-sharing S3 + filesystem layer, ported from the desktop
//! `handlers/sharing.ts`. The bundle assembly/parse lives in `bundle.rs`; this
//! module is the side-effecting half — S3 get/put of the bundle object and the
//! pre-import backup.

use aws_sdk_s3::config::Region;
use aws_sdk_s3::primitives::ByteStream;
use aws_smithy_types::error::display::DisplayErrorContext;
use chrono::Utc;
use std::path::Path;

/// Parse `s3://bucket/key` (scheme optional) → (bucket, key). None when it
/// can't be a single-object target (no bucket, empty key, or trailing slash).
pub fn split_s3_location(location: &str) -> Option<(String, String)> {
    let stripped = location.trim().strip_prefix("s3://").unwrap_or(location.trim());
    let idx = stripped.find('/')?;
    if idx == 0 {
        return None;
    }
    let bucket = stripped[..idx].to_string();
    let key = stripped[idx + 1..].to_string();
    if key.is_empty() || key.ends_with('/') {
        return None;
    }
    Some((bucket, key))
}

/// Default publish target: the well-known beacon key at the bucket ROOT (any
/// CUR prefix dropped — discovery probes the root).
pub fn suggested_beacon_location(daily_bucket: &str) -> String {
    let stripped = daily_bucket.trim().strip_prefix("s3://").unwrap_or(daily_bucket.trim());
    let bucket = stripped.split('/').next().unwrap_or(stripped);
    format!("s3://{bucket}/{}", crate::bundle::CONFIG_BEACON_KEY)
}

/// S3 errors that mean "nothing published here" rather than "broken".
pub fn is_beacon_absence(err: &str) -> bool {
    err.contains("NoSuchKey") || err.contains("NotFound") || err.contains("NoSuchBucket") || err.contains("AccessDenied")
}

async fn s3_client(profile: &str) -> aws_sdk_s3::Client {
    // The Rust S3 client follows cross-region redirects on its own (no explicit
    // followRegionRedirects toggle needed, unlike the JS SDK Electron uses).
    let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .profile_name(profile.to_string())
        .region(Region::new("eu-central-1"))
        .load()
        .await;
    aws_sdk_s3::Client::new(&shared)
}

/// Fetch an object's body as UTF-8. Errors are returned verbatim (caller uses
/// `is_beacon_absence` to decide absence vs real failure).
pub async fn s3_get(bucket: &str, key: &str, profile: &str) -> Result<String, String> {
    let client = s3_client(profile).await;
    let resp = client.get_object().bucket(bucket).key(key).send().await.map_err(|e| DisplayErrorContext(&e).to_string())?;
    let data = resp.body.collect().await.map_err(|e| e.to_string())?;
    String::from_utf8(data.to_vec()).map_err(|e| format!("bundle is not UTF-8: {e}"))
}

pub async fn s3_put(bucket: &str, key: &str, body: String, profile: &str) -> Result<(), String> {
    let client = s3_client(profile).await;
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body.into_bytes()))
        .content_type("application/yaml")
        .send()
        .await
        .map_err(|e| DisplayErrorContext(&e).to_string())?;
    Ok(())
}

/// Copy whichever config files exist into config/backups/<timestamp>/ so an
/// import is one folder-copy away from being undone. Returns the backup dir.
pub fn backup_config(config_dir: &Path) -> Result<Option<String>, String> {
    let candidates = ["costgoblin.yaml", "dimensions.yaml", "org-tree.yaml", "cost-scope.yaml", "views.yaml"];
    let existing: Vec<&str> = candidates.iter().copied().filter(|f| config_dir.join(f).exists()).collect();
    if existing.is_empty() {
        return Ok(None);
    }
    let stamp = Utc::now().to_rfc3339().replace(':', "-");
    let backup_dir = config_dir.join("backups").join(&stamp);
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("mkdir backup: {e}"))?;
    for f in existing {
        std::fs::copy(config_dir.join(f), backup_dir.join(f)).map_err(|e| format!("backup {f}: {e}"))?;
    }
    Ok(Some(backup_dir.to_string_lossy().to_string()))
}
