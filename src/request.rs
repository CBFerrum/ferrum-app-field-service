//! Service requests: from staff, the helpdesk (with the Helpdesk app installed a ticket's details
//! are copied) or customers (the public endpoint). A request becomes one work order; customers
//! follow it with a signed tracking link.

use crate::logic::Ts;
use crate::setup::{Settings, coordinates, has, point};
use crate::{linked, notify, require_dispatcher, stored, ts, ts_value};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use ferrum_domain::flow::create_for_user;
use ferrum_domain::flow::created;
use ferrum_domain::util::{id, s, set, sys};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, FieldError, Filter, HookCtx, Kernel, Result, Tx};
use serde_json::{Value, json};
use uuid::Uuid;

pub struct RequestHook;

/// Fields a request hands to its work order.
const CARRIED: [&str; 12] = [
    "customer",
    "contact_name",
    "contact_email",
    "contact_phone",
    "equipment",
    "site_address",
    "latitude",
    "longitude",
    "territory",
    "work_type",
    "priority",
    "preferred_start",
];

/// The customer whose email this is, when exactly one customer has it.
pub async fn customer_by_email(k: &Kernel, ctx: &Ctx, tx: &mut Tx, email: &str) -> Result<Option<Uuid>> {
    let found = k.find_tx(&sys(ctx), tx, "Customer", &[Filter::eq("email", email.trim().to_lowercase()), Filter::eq("disabled", false)], None, 2).await?;
    Ok(if found.len() == 1 { id(&found[0], "id") } else { None })
}

/// A tracking link for a request: the path on this server, the absolute URL when the public
/// address is known (the Mail app's settings), and when it expires.
pub async fn tracking_link(ctx: &Ctx, tx: &mut Tx, request: Uuid, days: i64) -> Result<(String, Option<String>, Ts)> {
    let expires = Utc::now() + Duration::days(days.clamp(1, 365));
    let token = notify::tracking_token(tx, ctx.tenant, request, expires).await?;
    let path = notify::tracking_path(tx, ctx.tenant, &token).await?;
    let base: Option<String> = if ctx.schema.entity("CommsSettings").is_some() {
        sqlx::query_scalar::<_, Option<String>>("select public_url from e_comms_settings where tenant_id = $1 limit 1")
            .bind(ctx.tenant)
            .fetch_optional(&mut **tx)
            .await?
            .flatten()
    } else {
        None
    };
    let url = base.map(|b| b.trim().trim_end_matches('/').to_string()).filter(|b| !b.is_empty()).map(|b| format!("{b}{path}"));
    Ok((path, url, expires))
}

/// Copies a helpdesk ticket's details where the request has none (the Helpdesk app is optional:
/// without it the reference is kept as text).
async fn from_ticket(hc: &mut HookCtx<'_>, doc: &mut Doc, reference: &str) -> Result<()> {
    if hc.ctx.schema.entity("Ticket").is_none() {
        return Ok(());
    }
    let sctx = sys(hc.ctx);
    let ticket = match Uuid::try_parse(reference.trim()) {
        Ok(t) => linked(hc.kernel, hc.ctx, hc.tx, "Ticket", t).await?,
        Err(_) => hc.kernel.find_tx(&sctx, hc.tx, "Ticket", &[Filter::eq("number", reference.trim())], None, 1).await?.into_iter().next(),
    };
    let ticket = ticket.ok_or_else(|| Error::field("helpdesk_ticket", "no helpdesk ticket has this id or number"))?;
    for (to, from) in
        [("customer", "customer"), ("contact_name", "contact_name"), ("contact_email", "contact_email"), ("subject", "subject"), ("description", "description")]
    {
        if !has(doc, to) && has(&ticket, from) {
            set(doc, to, ticket.get(from).cloned().unwrap_or(Value::Null));
        }
    }
    if let Some(p) = s(&ticket, "priority").filter(|p| crate::logic::PRIORITIES.contains(p)) {
        set(doc, "priority", p.to_string());
    }
    if id(doc, "equipment").is_none()
        && let (Some(customer), Some(serial)) = (id(doc, "customer"), s(&ticket, "serial_no"))
    {
        let mut filters = vec![Filter::eq("customer", customer.to_string()), Filter::eq("serial_no", serial)];
        if let Some(item) = id(&ticket, "item") {
            filters.push(Filter::eq("item", item.to_string()));
        }
        if let Some(eq) = hc.kernel.find_tx(&sctx, hc.tx, "CustomerEquipment", &filters, None, 1).await?.first() {
            set(doc, "equipment", eq.get("id").cloned().unwrap_or(Value::Null));
        }
    }
    set(doc, "source", "Helpdesk");
    Ok(())
}

#[async_trait]
impl DocHook for RequestHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let old = stored(hc, doc).await?;
        if let Some(o) = &old
            && let Some(final_status @ ("Converted" | "Rejected")) = s(o, "status")
        {
            return Err(Error::invalid(format!("a {} request is final", final_status.to_lowercase())));
        }
        if let Some(t) = s(doc, "helpdesk_ticket").map(str::to_string)
            && old.as_ref().is_none_or(|o| s(o, "helpdesk_ticket") != Some(t.as_str()))
        {
            from_ticket(hc, doc, &t).await?;
        }
        if let Some(e) = id(doc, "equipment")
            && let Some(eq) = linked(hc.kernel, hc.ctx, hc.tx, "CustomerEquipment", e).await?
        {
            if id(doc, "customer").is_none() {
                set(doc, "customer", eq.get("customer").cloned().unwrap_or(Value::Null));
            }
            for f in ["site_address", "territory"] {
                if !has(doc, f) {
                    set(doc, f, eq.get(f).cloned().unwrap_or(Value::Null));
                }
            }
            if point(doc, "latitude", "longitude").is_none() && point(&eq, "latitude", "longitude").is_some() {
                set(doc, "latitude", eq.get("latitude").cloned().unwrap_or(Value::Null));
                set(doc, "longitude", eq.get("longitude").cloned().unwrap_or(Value::Null));
            }
        }
        if id(doc, "customer").is_none()
            && let Some(email) = s(doc, "contact_email").map(str::to_string)
            && let Some(c) = customer_by_email(hc.kernel, hc.ctx, hc.tx, &email).await?
        {
            set(doc, "customer", c.to_string());
        }
        if let Some(c) = id(doc, "customer")
            && let Some(customer) = linked(hc.kernel, hc.ctx, hc.tx, "Customer", c).await?
        {
            for (to, from) in [("contact_email", "email"), ("contact_phone", "phone")] {
                if !has(doc, to) && has(&customer, from) {
                    set(doc, to, customer.get(from).cloned().unwrap_or(Value::Null));
                }
            }
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let old = stored(hc, doc).await?;
        let mut errors = Vec::new();
        match &old {
            Some(o) if o.get("requested_at") != doc.get("requested_at") && !hc.ctx.is_system => {
                errors.push(FieldError::new("requested_at", "cannot be changed once the request exists"))
            }
            None if ts(doc, "requested_at").is_some_and(|t| t > Utc::now() + Duration::minutes(5)) => {
                errors.push(FieldError::new("requested_at", "cannot be in the future"))
            }
            _ => {}
        }
        if let (Some(e), Some(c)) = (id(doc, "equipment"), id(doc, "customer"))
            && let Some(eq) = linked(hc.kernel, hc.ctx, hc.tx, "CustomerEquipment", e).await?
            && id(&eq, "customer") != Some(c)
        {
            errors.push(FieldError::new("equipment", "belongs to another customer"));
        }
        if let Err(Error::Validation(e)) = coordinates(doc) {
            errors.extend(e);
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        let request = id(doc, "id").ok_or_else(|| Error::internal("request without id"))?;
        match name {
            "make_work_order" => {
                if let Some(wo) = id(doc, "work_order") {
                    return Err(Error::invalid(format!("this request already became work order {wo}")));
                }
                if id(doc, "customer").is_none() {
                    return Err(Error::field("customer", "set the customer before creating the work order"));
                }
                let mut input = Doc::new();
                if let Some(c) = params.get("company").and_then(Value::as_str) {
                    input.insert("company".into(), json!(c));
                }
                for f in CARRIED {
                    if has(doc, f) {
                        input.insert(f.into(), doc.get(f).cloned().unwrap_or(Value::Null));
                    }
                }
                let description = match s(doc, "description") {
                    Some(d) => format!("{}\n\n{d}", s(doc, "subject").unwrap_or_default()),
                    None => s(doc, "subject").unwrap_or_default().to_string(),
                };
                input.insert("description".into(), json!(description));
                // The SLA counts from when the customer asked, not from the conversion.
                input.insert("reported_at".into(), doc.get("requested_at").cloned().unwrap_or(Value::Null));
                input.insert("service_request".into(), json!(request.to_string()));
                let wo = create_for_user(hc, "ServiceWorkOrder", input).await?;
                let mut v = Doc::new();
                v.insert("status".into(), json!("Converted"));
                v.insert("work_order".into(), wo.get("id").cloned().unwrap_or(Value::Null));
                hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceRequest", request, v).await?;
                Ok(Some(created("ServiceWorkOrder", &wo)))
            }
            "reject" => {
                require_dispatcher(hc.ctx, "reject service requests")?;
                let reason = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .ok_or_else(|| Error::field("reason", "say why the request is rejected"))?;
                if reason.chars().count() > 2000 {
                    return Err(Error::field("reason", "at most 2000 characters"));
                }
                let mut v = Doc::new();
                v.insert("status".into(), json!("Rejected"));
                v.insert("rejection_reason".into(), json!(reason));
                hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceRequest", request, v).await?;
                let title = format!("Service request {} was rejected: {reason}", s(doc, "number").unwrap_or_default());
                if let Some(creator) = id(doc, "created_by").filter(|c| *c != hc.ctx.user) {
                    notify::user(hc.tx, hc.ctx.tenant, creator, &title, "ServiceRequest", request).await?;
                }
                let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
                let mut emailed = false;
                if settings.notify_customer
                    && let Some(to) = s(doc, "contact_email")
                {
                    let html = format!(
                        "<p>We are sorry: your service request {} ({}) cannot be taken on.</p><p>{}</p>",
                        notify::escape(s(doc, "number").unwrap_or_default()),
                        notify::escape(s(doc, "subject").unwrap_or_default()),
                        notify::escape(reason)
                    );
                    emailed = notify::email_customer(hc.kernel, hc.ctx, hc.tx, to, "Your service request", &html, ("ServiceRequest", request)).await?;
                }
                Ok(Some(json!({"status": "Rejected", "customer_emailed": emailed})))
            }
            "tracking_link" => {
                let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
                let (path, url, expires) = tracking_link(hc.ctx, hc.tx, request, settings.tracking_days).await?;
                let mut emailed = false;
                if params.get("send").and_then(Value::as_bool) == Some(true) {
                    let to = s(doc, "contact_email").ok_or_else(|| Error::field("contact_email", "the request has no contact email to send the link to"))?;
                    let link = url.clone().unwrap_or_else(|| path.clone());
                    let html = format!(
                        "<p>You can follow your service request {} here:</p><p><a href=\"{l}\">{l}</a></p><p>The link works until {}.</p>",
                        notify::escape(s(doc, "number").unwrap_or_default()),
                        expires.format("%Y-%m-%d"),
                        l = notify::escape(&link)
                    );
                    emailed = notify::email_customer(hc.kernel, hc.ctx, hc.tx, to, "Follow your service request", &html, ("ServiceRequest", request)).await?;
                }
                Ok(Some(json!({"path": path, "url": url, "expires_at": ts_value(expires), "emailed": emailed})))
            }
            _ => Ok(None),
        }
    }
}
