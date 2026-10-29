//! The package's endpoints: `/api/app/field_service/dispatch` (signed in: the dispatch board) and,
//! for customers, `/api/site/{tenant}/field_service/requests` (file a request, when the settings
//! allow it) and `/api/site/{tenant}/field_service/track/{token}` (follow it with a signed,
//! expiring link). Public handlers act with the system context after validating their input and
//! show only what a customer may see; unknown, invalid and expired tokens all answer 404.

use crate::request::{customer_by_email, tracking_link};
use crate::setup::Settings;
use crate::{dispatch, notify, opt_ts, ts};
use async_trait::async_trait;
use chrono::Utc;
use ferrum_domain::util::{id, rows, s};
use ferrum_kernel::{Ctx, Doc, Error, Filter, Kernel, Result, Site, SiteRequest, SiteResponse, value::parse_datetime};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const MAX_BODY: usize = 64 * 1024;
/// Public requests per address, and per email address, in an hour.
const PER_IP_HOUR: i64 = 10;
const PER_EMAIL_HOUR: i64 = 5;

pub struct FieldServiceSite;

#[async_trait]
impl Site for FieldServiceSite {
    fn max_body(&self) -> usize {
        MAX_BODY
    }

    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let path: Vec<String> = req.path.split('/').filter(|p| !p.is_empty()).map(str::to_string).collect();
        let segs: Vec<&str> = path.iter().map(String::as_str).collect();
        let mut resp = match (&req.user, req.method.as_str(), segs.as_slice()) {
            (Some(ctx), "GET", ["dispatch"]) => SiteResponse::json(200, &dispatch::board(k, ctx, &req.query).await?),
            (None, "POST", ["requests"]) => public_request(k, &req).await?,
            (_, "GET", ["track", token]) => track(k, &req, token).await?,
            _ => return Err(Error::NotFound("page".into())),
        };
        resp.headers.push(("cache-control".into(), "no-store".into()));
        Ok(resp)
    }
}

fn body(req: &SiteRequest) -> Result<Map<String, Value>> {
    if req.body.len() > MAX_BODY {
        return Err(Error::invalid("request body larger than 64 KB"));
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(Error::invalid("the request body must be a JSON object")),
    }
}

/// A trimmed text field of at most `max` characters, without control characters (newlines
/// allowed where `multiline`).
fn text(b: &Map<String, Value>, key: &str, max: usize, required: bool, multiline: bool) -> Result<Option<String>> {
    let v = match b.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(v)) => Some(v.trim().to_string()).filter(|v| !v.is_empty()),
        Some(_) => return Err(Error::field(key, "must be text")),
    };
    match v {
        None if required => Err(Error::field(key, "is required")),
        Some(v) if v.chars().count() > max => Err(Error::field(key, format!("at most {max} characters"))),
        Some(v) if v.chars().any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\r' || c == '\t'))) => {
            Err(Error::field(key, "contains control characters"))
        }
        other => Ok(other),
    }
}

/// `POST /requests` (public): `{subject, contact_name, contact_email, description?, contact_phone?,
/// site_address?, serial_no?, preferred_start?, work_type?}` → `201 {reference, status,
/// tracking_path, tracking_url, expires_at}`.
async fn public_request(k: &Kernel, req: &SiteRequest) -> Result<SiteResponse> {
    let ctx = Ctx::system(req.tenant, k.registry.schema(req.tenant).await?);
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let settings = Settings::load(k, &ctx, &mut tx).await?;
    if !settings.public_requests {
        return Err(Error::NotFound("page".into()));
    }
    let b = body(req)?;
    let subject = text(&b, "subject", 300, true, false)?;
    let contact_name = text(&b, "contact_name", 140, true, false)?;
    let email = text(&b, "contact_email", 254, true, false)?.unwrap_or_default().to_lowercase();
    let description = text(&b, "description", 5000, false, true)?;
    let phone = text(&b, "contact_phone", 40, false, false)?;
    let address = text(&b, "site_address", 2000, false, true)?;
    let serial = text(&b, "serial_no", 140, false, false)?;
    let work_type = text(&b, "work_type", 20, false, false)?;
    if work_type.as_deref().is_some_and(|w| !["Repair", "Installation", "Maintenance", "Inspection"].contains(&w)) {
        return Err(Error::field("work_type", "use Repair, Installation, Maintenance or Inspection"));
    }
    let preferred = match text(&b, "preferred_start", 40, false, false)? {
        Some(v) => Some(parse_datetime(&v).map_err(|m| Error::field("preferred_start", m))?),
        None => None,
    };
    // Only public submissions count: staff entering requests for the same address do not.
    let recent = |column: &str| {
        format!(
            "select count(*) from e_service_request where tenant_id = $1 and source = 'Customer Portal' and {column} = $2 and created_at > now() - interval '1 hour'"
        )
    };
    let by_ip: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(recent("source_ip"))).bind(req.tenant).bind(&req.client_ip).fetch_one(&mut *tx).await?;
    let by_email: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(recent("lower(contact_email)"))).bind(req.tenant).bind(&email).fetch_one(&mut *tx).await?;
    if by_ip >= PER_IP_HOUR || by_email >= PER_EMAIL_HOUR {
        return Err(Error::TooManyRequests("too many service requests; please try again later".into()));
    }
    let mut input = Doc::new();
    input.insert("subject".into(), json!(subject));
    input.insert("description".into(), json!(description));
    input.insert("contact_name".into(), json!(contact_name));
    input.insert("contact_email".into(), json!(email));
    input.insert("contact_phone".into(), json!(phone));
    input.insert("site_address".into(), json!(address));
    input.insert("work_type".into(), json!(work_type.unwrap_or_else(|| "Repair".into())));
    input.insert("preferred_start".into(), opt_ts(preferred));
    input.insert("source".into(), json!("Customer Portal"));
    input.insert("source_ip".into(), json!(req.client_ip.chars().take(64).collect::<String>()));
    // Equipment is linked only for the customer this email address identifies.
    if let Some(customer) = customer_by_email(k, &ctx, &mut tx, &email).await? {
        input.insert("customer".into(), json!(customer.to_string()));
        if let Some(sn) = &serial
            && let Some(eq) = k
                .find_tx(&ctx, &mut tx, "CustomerEquipment", &[Filter::eq("customer", customer.to_string()), Filter::eq("serial_no", sn.as_str())], None, 1)
                .await?
                .first()
        {
            input.insert("equipment".into(), eq.get("id").cloned().unwrap_or(Value::Null));
        }
    }
    if let (Some(sn), None) = (&serial, input.get("equipment")) {
        let note = format!("{}\n\nSerial number given: {sn}", description.clone().unwrap_or_default());
        input.insert("description".into(), json!(note.trim()));
    }
    let created = k.insert_tx(&ctx, &mut tx, "ServiceRequest", input).await?;
    let rid = id(&created, "id").ok_or_else(|| Error::internal("request without id"))?;
    let (path, url, expires) = tracking_link(&ctx, &mut tx, rid, settings.tracking_days).await?;
    let number = s(&created, "number").unwrap_or_default().to_string();
    if settings.notify_customer {
        let link = url.clone().unwrap_or_else(|| path.clone());
        let html = format!(
            "<p>Thank you, we received your service request {} ({}).</p><p><a href=\"{l}\">Follow it here</a>.</p>",
            notify::escape(&number),
            notify::escape(subject.as_deref().unwrap_or_default()),
            l = notify::escape(&link)
        );
        notify::email_customer(k, &ctx, &mut tx, &email, &format!("Service request {number} received"), &html, ("ServiceRequest", rid)).await?;
    }
    tx.commit().await?;
    Ok(SiteResponse::json(
        201,
        &json!({"reference": number, "status": created.get("status"), "tracking_path": path, "tracking_url": url, "expires_at": crate::ts_value(expires)}),
    ))
}

/// What a customer sees of their request and its visit.
async fn tracking_view(k: &Kernel, ctx: &Ctx, tx: &mut ferrum_kernel::Tx, request: Uuid) -> Result<Option<Value>> {
    let Some(r) = crate::linked(k, ctx, tx, "ServiceRequest", request).await? else { return Ok(None) };
    let visit = match id(&r, "work_order") {
        Some(wo) => match crate::linked(k, ctx, tx, "ServiceWorkOrder", wo).await? {
            Some(w) => {
                let technicians: Vec<String> = rows(&w, "crew").iter().filter_map(|c| s(c, "technician_name").map(crate::appointment::first_name)).collect();
                json!({
                    "status": w.get("status"), "scheduled_start": w.get("scheduled_start"), "scheduled_end": w.get("scheduled_end"),
                    "technicians": technicians, "on_the_way_since": opt_ts(ts(&w, "travel_started_at").filter(|_| s(&w, "status") == Some("En Route"))),
                    "arrived_at": w.get("arrived_at"), "completed_at": w.get("completed_at"),
                })
            }
            None => Value::Null,
        },
        None => Value::Null,
    };
    Ok(Some(json!({
        "reference": r.get("number"), "subject": r.get("subject"), "status": r.get("status"), "requested_at": r.get("requested_at"),
        "rejection_reason": r.get("rejection_reason"), "visit": visit,
    })))
}

/// `GET /track/{token}` → the request's status and its visit (JSON, or a small page for browsers).
async fn track(k: &Kernel, req: &SiteRequest, token: &str) -> Result<SiteResponse> {
    let ctx = Ctx::system(req.tenant, k.registry.schema(req.tenant).await?);
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let view = match notify::verify_tracking(&mut tx, req.tenant, token, Utc::now()).await? {
        Some(request) => tracking_view(k, &ctx, &mut tx, request).await?,
        None => None,
    };
    tx.commit().await?;
    let view = view.ok_or_else(|| Error::NotFound("page".into()))?;
    let wants_html = req.headers.iter().any(|(h, v)| h.eq_ignore_ascii_case("accept") && v.as_str().is_some_and(|a| a.contains("text/html")));
    let mut resp = if wants_html { page(&ctx, &view) } else { SiteResponse::json(200, &view) };
    resp.headers.push(("referrer-policy".into(), "no-referrer".into()));
    resp.headers.push(("x-robots-tag".into(), "noindex".into()));
    Ok(resp)
}

fn page(ctx: &Ctx, v: &Value) -> SiteResponse {
    let e = |x: &Value| notify::escape(x.as_str().unwrap_or_default());
    let when = |x: &Value| {
        x.as_str()
            .and_then(|t| parse_datetime(t).ok())
            .map(|t| t.with_timezone(&crate::logic::zone(None, &ctx.schema.timezone)).format("%a %-d %b %Y, %H:%M").to_string())
            .unwrap_or_default()
    };
    let mut body = format!("<p>Request {} — {}</p><p>Status: <strong>{}</strong></p>", e(&v["reference"]), e(&v["subject"]), e(&v["status"]));
    if !v["rejection_reason"].is_null() {
        body.push_str(&format!("<p>{}</p>", e(&v["rejection_reason"])));
    }
    let visit = &v["visit"];
    if !visit.is_null() {
        body.push_str(&format!("<p>Visit: <strong>{}</strong></p>", e(&visit["status"])));
        if !visit["scheduled_start"].is_null() {
            body.push_str(&format!("<p>Planned: {} – {}</p>", when(&visit["scheduled_start"]), when(&visit["scheduled_end"])));
        }
        let names: Vec<String> = visit["technicians"].as_array().map(|a| a.iter().map(e).collect()).unwrap_or_default();
        if !names.is_empty() {
            body.push_str(&format!("<p>Technician: {}</p>", names.join(", ")));
        }
        for (key, label) in [("on_the_way_since", "On the way since"), ("arrived_at", "Arrived"), ("completed_at", "Completed")] {
            if !visit[key].is_null() {
                body.push_str(&format!("<p>{label}: {}</p>", when(&visit[key])));
            }
        }
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>Your service request</title><style>body{{font:15px/1.5 system-ui,sans-serif;\
         margin:0;padding:40px 16px;background:#f6f8fa;color:#1f2328}}main{{max-width:460px;margin:auto;background:#fff;border:1px solid #d0d7de;\
         border-radius:8px;padding:24px}}</style></head><body><main><h1>Your service request</h1>{body}</main></body></html>"
    );
    let mut r = SiteResponse::text(200, "text/html; charset=utf-8", html);
    r.headers.push(("content-security-policy".into(), "default-src 'none'; style-src 'unsafe-inline'".into()));
    r.headers.push(("x-frame-options".into(), "DENY".into()));
    r
}
