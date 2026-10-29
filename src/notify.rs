//! Telling people: technicians and staff in the app, customers by email through the Mail app
//! when it is installed (a `Communication` record; delivery and retries are Mail's job), and the
//! customers' tracking links, signed with a per-tenant key and valid until their expiry.

use chrono::{DateTime, Utc};
use ferrum_domain::util::elevated;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx, notify};
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use uuid::Uuid;

/// In-app notifications for the active users signed in with these emails (others are skipped).
pub async fn emails(tx: &mut Tx, tenant: Uuid, emails: &[String], title: &str, entity: &str, record: Uuid) -> Result<()> {
    let wanted: Vec<String> = emails.iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let users: Vec<Uuid> = sqlx::query_scalar("select id from app_user where tenant_id = $1 and is_active and lower(email::text) = any($2) order by id")
        .bind(tenant)
        .bind(&wanted)
        .fetch_all(&mut **tx)
        .await?;
    for user in users {
        notify::send(tx, tenant, user, title, None, Some(entity), Some(record)).await?;
    }
    Ok(())
}

/// An in-app notification for one user (e.g. whoever created a record), if they are still active.
pub async fn user(tx: &mut Tx, tenant: Uuid, user: Uuid, title: &str, entity: &str, record: Uuid) -> Result<()> {
    let active: bool = sqlx::query_scalar("select exists (select 1 from app_user where tenant_id = $1 and id = $2 and is_active)")
        .bind(tenant)
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    if active {
        notify::send(tx, tenant, user, title, None, Some(entity), Some(record)).await?;
    }
    Ok(())
}

/// Emails a customer through the Mail app: a queued `Communication` on `reference`'s timeline.
/// Returns `false` (nothing sent) when the workspace has no Mail app.
pub async fn email_customer(k: &Kernel, ctx: &Ctx, tx: &mut Tx, to: &str, subject: &str, html: &str, reference: (&str, Uuid)) -> Result<bool> {
    if !ctx.schema.packages.iter().any(|p| p == "comms") || ctx.schema.entity("Communication").is_none() {
        return Ok(false);
    }
    let mut c = Doc::new();
    c.insert("channel".into(), json!("Email"));
    c.insert("direction".into(), json!("Sent"));
    c.insert("recipients".into(), json!(to));
    c.insert("subject".into(), json!(subject));
    c.insert("content".into(), json!(html));
    c.insert("reference_entity".into(), json!(reference.0));
    c.insert("reference_id".into(), json!(reference.1.to_string()));
    // Engine rights (the user may not use Mail), the user's name on the record.
    k.insert_tx(&elevated(ctx), tx, "Communication", c).await?;
    Ok(true)
}

pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

// ───────────────────────────── tracking links ─────────────────────────────

/// The tenant's key for tracking links, created on first use (concurrent first uses agree).
async fn key(tx: &mut Tx, tenant: Uuid) -> Result<Vec<u8>> {
    let fresh: [u8; 32] = rand::random();
    sqlx::query("insert into field_service_secret (tenant_id, secret) values ($1, $2) on conflict do nothing")
        .bind(tenant)
        .bind(&fresh[..])
        .execute(&mut **tx)
        .await?;
    Ok(sqlx::query_scalar("select secret from field_service_secret where tenant_id = $1").bind(tenant).fetch_one(&mut **tx).await?)
}

fn mac(key: &[u8], request: Uuid, expires: i64) -> Result<Hmac<Sha256>> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).map_err(Error::internal)?;
    m.update(format!("ferrum-field-service-track:{request}:{expires}").as_bytes());
    Ok(m)
}

/// `{request}.{expiry, unix seconds}.{128-bit HMAC}`: names its request, unguessable, expiring.
pub async fn tracking_token(tx: &mut Tx, tenant: Uuid, request: Uuid, expires: DateTime<Utc>) -> Result<String> {
    let key = key(tx, tenant).await?;
    let tag = mac(&key, request, expires.timestamp())?.finalize().into_bytes();
    Ok(format!("{}.{}.{}", request.simple(), expires.timestamp(), hex::encode(&tag[..16])))
}

/// The request a token grants, if its signature holds (compared in constant time) and it has
/// not expired. Anything else is `None`, so callers answer "not found" alike.
pub async fn verify_tracking(tx: &mut Tx, tenant: Uuid, token: &str, now: DateTime<Utc>) -> Result<Option<Uuid>> {
    let parts: Vec<&str> = token.trim().split('.').collect();
    let [request, expires, sig] = parts.as_slice() else { return Ok(None) };
    let (Ok(request), Ok(expires), Ok(sig)) = (Uuid::try_parse(request), expires.parse::<i64>(), hex::decode(sig)) else { return Ok(None) };
    if sig.len() != 16 || expires < now.timestamp() {
        return Ok(None);
    }
    let key = key(tx, tenant).await?;
    Ok(mac(&key, request, expires)?.verify_truncated_left(&sig).is_ok().then_some(request))
}

/// The public tracking page of a token, relative to the server root.
pub async fn tracking_path(tx: &mut Tx, tenant: Uuid, token: &str) -> Result<String> {
    let slug: String = sqlx::query_scalar("select slug from tenant where id = $1").bind(tenant).fetch_one(&mut **tx).await?;
    Ok(format!("/api/site/{slug}/{}/track/{token}", crate::PACKAGE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_macs_bind_request_expiry_and_key() {
        let (k1, k2) = ([1u8; 32], [2u8; 32]);
        let (r1, r2) = (Uuid::now_v7(), Uuid::now_v7());
        let tag = mac(&k1, r1, 1_800_000_000).unwrap().finalize().into_bytes();
        assert!(mac(&k1, r1, 1_800_000_000).unwrap().verify_truncated_left(&tag[..16]).is_ok());
        assert!(mac(&k1, r2, 1_800_000_000).unwrap().verify_truncated_left(&tag[..16]).is_err(), "another request");
        assert!(mac(&k1, r1, 1_900_000_000).unwrap().verify_truncated_left(&tag[..16]).is_err(), "a longer validity");
        assert!(mac(&k2, r1, 1_800_000_000).unwrap().verify_truncated_left(&tag[..16]).is_err(), "another tenant's key");
        assert_eq!(escape("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    }
}
