//! Service work orders. Every save derives the site and coverage (equipment, warranty, contract),
//! the checklist from its template, labour hours and rates, totals and the SLA verdict.
//! Completing is submitting: required checklist items, the signature and stock are checked, the
//! parts leave stock on a Material Issue and the work order is frozen. [`refresh`] re-derives the
//! crew, schedule, status and SLA after anything else changes (appointments, arrival, time).

use crate::logic::{self, Ts};
use crate::setup::{Settings, coordinates, has, point};
use crate::{appointment, child_table, dispatch, int, invoice, linked, my_technician, notify, opt_ts, require_dispatcher, stored, ts, ts_value};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use ferrum_domain::util::{Company, b, company, d, elevated, get, id, money, round, rows, s, set, sys};
use ferrum_kernel::value::parse_date;
use ferrum_kernel::{Ctx, Doc, DocHook, Error, FieldError, HookCtx, Kernel, Result, Tx, outbox};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

/// Statuses of a work order that is still being worked on (a draft that is not cancelled).
pub const OPEN: [&str; 5] = ["New", "Scheduled", "Dispatched", "En Route", "On Site"];

pub struct WorkOrderHook;

/// `number customer` for messages.
pub fn label(doc: &Doc) -> String {
    format!("{} {}", s(doc, "number").unwrap_or("Work order"), s(doc, "customer_name").unwrap_or_default()).trim().to_string()
}

fn row_by_id(old: Option<&Doc>, table: &str, row: &Doc) -> Option<Doc> {
    let rid = s(row, "id")?;
    old.and_then(|o| rows(o, table).into_iter().find(|r| s(r, "id") == Some(rid)))
}

/// A child row made by the engine (rows from users get their ids from the kernel).
fn new_row(mut row: Doc, idx: usize) -> Value {
    row.insert("id".into(), json!(Uuid::now_v7().to_string()));
    row.insert("idx".into(), json!(idx));
    Value::Object(row)
}

fn delta(doc: &Doc, fields: Doc) -> Doc {
    fields.into_iter().filter(|(k, v)| doc.get(k).unwrap_or(&Value::Null) != v).collect()
}

/// The workspace-local date of an instant.
fn local_day(ctx: &Ctx, t: Ts) -> chrono::NaiveDate {
    t.with_timezone(&logic::zone(None, &ctx.schema.timezone)).date_naive()
}

// ───────────────────────────── service levels and coverage ─────────────────────────────

/// The SLA fields of a work order as of `now`. The clock starts when the problem was reported (a
/// planned contract visit: at the start of its due day); targets come from the contract when it
/// sets them, else from the priority's targets in the settings. Cancelling stops the clock.
pub fn sla_fields(settings: &Settings, contract: Option<&Doc>, doc: &Doc, timezone: &str, now: Ts) -> Doc {
    let start = match s(doc, "contract_due_date").and_then(|v| parse_date(v).ok()) {
        Some(day) => Some(logic::local_instant(logic::zone(None, timezone), day, 0)),
        None => ts(doc, "reported_at"),
    };
    let priority = s(doc, "priority").unwrap_or("Medium");
    let target = |field: &str, pick: fn(&(Decimal, Decimal)) -> Decimal| {
        contract.map(|c| d(c, field)).filter(|h| *h > Decimal::ZERO).or_else(|| settings.sla.get(priority).map(pick))
    };
    let mut out = Doc::new();
    match (start, target("sla_response_hours", |t| t.0), target("sla_resolution_hours", |t| t.1)) {
        (Some(start), Some(r), Some(z)) => {
            let stop = ts(doc, "cancelled_at").unwrap_or(now);
            let v = logic::sla_verdict(start, r, z, ts(doc, "arrived_at"), ts(doc, "completed_at"), stop);
            out.insert("sla_start".into(), ts_value(start));
            out.insert("response_hours".into(), money(r));
            out.insert("resolution_hours".into(), money(z));
            out.insert("response_due".into(), ts_value(v.response_due));
            out.insert("resolution_due".into(), ts_value(v.resolution_due));
            out.insert("response_breached".into(), json!(v.response_breached));
            out.insert("resolution_breached".into(), json!(v.resolution_breached));
            out.insert("sla_status".into(), json!(v.status));
        }
        _ => {
            for f in ["sla_start", "response_hours", "resolution_hours", "response_due", "resolution_due", "sla_status"] {
                out.insert(f.into(), Value::Null);
            }
            out.insert("response_breached".into(), json!(false));
            out.insert("resolution_breached".into(), json!(false));
        }
    }
    out
}

/// The submitted contract covering a job reported on `day`: the customer's, for this equipment
/// (preferred) or all of their equipment, whose term includes the day.
async fn covering_contract(k: &Kernel, ctx: &Ctx, tx: &mut Tx, customer: Uuid, equipment: Option<Uuid>, day: chrono::NaiveDate) -> Result<Option<Doc>> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "select id from e_service_contract where tenant_id = $1 and docstatus = 1 and status <> 'Cancelled' and customer = $2 \
         and (equipment is null or equipment = $3) and start_date <= $4 and end_date >= $4 \
         order by (equipment is not null) desc, start_date desc, id limit 1",
    )
    .bind(ctx.tenant)
    .bind(customer)
    .bind(equipment)
    .bind(day)
    .fetch_optional(&mut **tx)
    .await?;
    match found {
        Some(c) => Ok(Some(get(k, ctx, tx, "ServiceContract", c).await?)),
        None => Ok(None),
    }
}

async fn contract_of(k: &Kernel, ctx: &Ctx, tx: &mut Tx, doc: &Doc) -> Result<Option<Doc>> {
    match id(doc, "service_contract") {
        Some(c) => linked(k, ctx, tx, "ServiceContract", c).await,
        None => Ok(None),
    }
}

// ───────────────────────────── the document hook ─────────────────────────────

#[async_trait]
impl DocHook for WorkOrderHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if int(doc, "docstatus") != 0 {
            return Ok(());
        }
        let old = stored(hc, doc).await?;
        if let Some(o) = &old
            && s(o, "status") == Some("Cancelled")
        {
            return Err(Error::invalid("a cancelled work order is final; create a new one for further work"));
        }
        let (k, ctx) = (hc.kernel, hc.ctx);
        let settings = Settings::load(k, ctx, hc.tx).await?;
        let now = Utc::now();

        // The site follows the equipment (or the customer's address) where it is not given.
        let equipment = match id(doc, "equipment") {
            Some(e) => linked(k, ctx, hc.tx, "CustomerEquipment", e).await?,
            None => None,
        };
        if let Some(eq) = &equipment {
            if id(doc, "customer").is_none() {
                set(doc, "customer", eq.get("customer").cloned().unwrap_or(Value::Null));
            }
            for f in ["site_address", "territory"] {
                if s(doc, f).is_none() {
                    set(doc, f, eq.get(f).cloned().unwrap_or(Value::Null));
                }
            }
            if !has(doc, "latitude") && !has(doc, "longitude") && point(eq, "latitude", "longitude").is_some() {
                set(doc, "latitude", eq.get("latitude").cloned().unwrap_or(Value::Null));
                set(doc, "longitude", eq.get("longitude").cloned().unwrap_or(Value::Null));
            }
        }
        if s(doc, "site_address").is_none()
            && let Some(c) = id(doc, "customer")
            && let Some(customer) = linked(k, ctx, hc.tx, "Customer", c).await?
            && let Some(address) = s(&customer, "shipping_address").or(s(&customer, "billing_address"))
        {
            set(doc, "site_address", address.to_string());
        }

        // Coverage: the warranty on the day the problem was reported, and the covering contract.
        let reported = ts(doc, "reported_at").unwrap_or(now);
        let day = local_day(ctx, reported);
        let contract = if s(doc, "contract_due_date").is_some() {
            contract_of(k, ctx, hc.tx, doc).await?
        } else {
            match id(doc, "customer") {
                Some(c) => covering_contract(k, ctx, hc.tx, c, id(doc, "equipment"), day).await?,
                None => None,
            }
        };
        set(doc, "service_contract", contract.as_ref().and_then(|c| c.get("id").cloned()).unwrap_or(Value::Null));
        let warranty = equipment.as_ref().and_then(|e| s(e, "warranty_end")).and_then(|w| parse_date(w).ok()).is_some_and(|end| end >= day);
        let warranty_labour = warranty && equipment.as_ref().is_some_and(|e| b(e, "warranty_covers_labour"));
        set(doc, "under_warranty", warranty);
        set(doc, "parts_covered", warranty || contract.as_ref().is_some_and(|c| b(c, "covers_parts")));
        set(doc, "labour_covered", warranty_labour || contract.as_ref().is_some_and(|c| b(c, "covers_labour")));
        if doc.get("estimated_duration_minutes").is_none_or(Value::is_null) {
            let planned = contract.as_ref().map(|c| int(c, "estimated_duration_minutes")).filter(|m| *m > 0);
            set(doc, "estimated_duration_minutes", planned.unwrap_or(settings.default_duration));
        }

        // A newly chosen template replaces the checklist.
        let template = id(doc, "checklist_template");
        if template.is_some() && old.as_ref().is_none_or(|o| id(o, "checklist_template") != template) {
            let t = get(k, ctx, hc.tx, "ServiceChecklistTemplate", template.unwrap_or_default()).await?;
            let tasks: Vec<Value> = rows(&t, "items")
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let mut row = Doc::new();
                    row.insert("task".into(), r.get("task").cloned().unwrap_or(Value::Null));
                    row.insert("required".into(), json!(b(r, "required")));
                    row.insert("done".into(), json!(false));
                    new_row(row, i)
                })
                .collect();
            set(doc, "checklist", Value::Array(tasks));
        }
        // Who ticked a task, and when, is recorded by the server.
        let checklist: Vec<Value> = rows(doc, "checklist")
            .into_iter()
            .map(|mut r| {
                if !b(&r, "done") {
                    r.insert("done_by".into(), Value::Null);
                    r.insert("done_at".into(), Value::Null);
                } else if s(&r, "done_at").is_none() {
                    r.insert("done_by".into(), json!(ctx.email.to_lowercase()));
                    r.insert("done_at".into(), ts_value(now));
                }
                Value::Object(r)
            })
            .collect();
        set(doc, "checklist", Value::Array(checklist));

        // Labour: the technician defaults to the user; hours by the billing step; the
        // technician's rates as they were when the time was entered.
        let me = my_technician(k, ctx, hc.tx).await?;
        let mut technicians: HashMap<Uuid, Doc> = HashMap::new();
        let mut labour = rows(doc, "labour");
        for r in labour.iter_mut() {
            if id(r, "technician").is_none()
                && let Some(t) = me.as_ref().and_then(|m| m.get("id"))
            {
                r.insert("technician".into(), t.clone());
                if let Some(n) = me.as_ref().and_then(|m| m.get("technician_name")) {
                    r.insert("technician_name".into(), n.clone());
                }
            }
            if let (Some(from), Some(to)) = (ts(r, "from_time"), ts(r, "to_time")) {
                r.insert("hours".into(), money(logic::labour_hours(from, to, settings.labour_step)));
            }
            let before = row_by_id(old.as_ref(), "labour", r);
            let fresh = before.as_ref().is_none_or(|o| id(o, "technician") != id(r, "technician"));
            if let Some(t) = id(r, "technician")
                && fresh
            {
                if let std::collections::hash_map::Entry::Vacant(e) = technicians.entry(t) {
                    e.insert(get(k, ctx, hc.tx, "Technician", t).await?);
                }
                r.insert("bill_rate".into(), money(d(&technicians[&t], "bill_rate")));
                r.insert("cost_rate".into(), money(d(&technicians[&t], "hourly_cost")));
            }
        }
        // Parts come from the user's van, else the lead technician's, else the default warehouse.
        let lead_van = match rows(doc, "crew").first().and_then(|c| id(c, "technician")) {
            Some(t) => linked(k, ctx, hc.tx, "Technician", t).await?.and_then(|t| id(&t, "van_warehouse")),
            None => None,
        };
        let van = me.as_ref().and_then(|m| id(m, "van_warehouse")).or(lead_van).or(settings.default_warehouse);
        let parts: Vec<Value> = rows(doc, "parts")
            .into_iter()
            .map(|mut r| {
                if id(&r, "warehouse").is_none()
                    && let Some(w) = van
                {
                    r.insert("warehouse".into(), json!(w.to_string()));
                }
                Value::Object(r)
            })
            .collect();
        set(doc, "parts", Value::Array(parts));
        let hours: Decimal = labour.iter().map(|r| d(r, "hours")).sum();
        let billable: Decimal = labour.iter().filter(|r| b(r, "billable")).map(|r| d(r, "hours")).sum();
        let cost: Decimal = labour.iter().map(|r| round(d(r, "hours") * d(r, "cost_rate"), 2)).sum();
        set(doc, "labour", Value::Array(labour.into_iter().map(Value::Object).collect()));
        set(doc, "labour_hours", money(hours));
        set(doc, "billable_hours", money(billable));
        set(doc, "labour_cost", money(cost));
        set(doc, "expense_total", money(rows(doc, "expenses").iter().map(|r| d(r, "amount")).sum()));

        // The signature is dated when it is given.
        let signature = s(doc, "customer_signature").map(str::to_string);
        if signature.is_none() {
            set(doc, "signed_at", Value::Null);
        } else if old.as_ref().is_none_or(|o| s(o, "customer_signature").map(str::to_string) != signature) || s(doc, "signed_at").is_none() {
            set(doc, "signed_at", ts_value(now));
        }

        doc.extend(sla_fields(&settings, contract.as_ref(), doc, &ctx.schema.timezone, now));
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if int(doc, "docstatus") != 0 {
            return Ok(());
        }
        let old = stored(hc, doc).await?;
        let mut errors = Vec::new();
        match &old {
            Some(o) if o.get("reported_at") != doc.get("reported_at") && !hc.ctx.is_system => {
                errors.push(FieldError::new("reported_at", "cannot be changed once the work order exists"))
            }
            None if ts(doc, "reported_at").is_some_and(|t| t > Utc::now() + Duration::minutes(5)) => {
                errors.push(FieldError::new("reported_at", "cannot be in the future"))
            }
            _ => {}
        }
        if let Some(e) = id(doc, "equipment")
            && let Some(eq) = linked(hc.kernel, hc.ctx, hc.tx, "CustomerEquipment", e).await?
            && id(&eq, "customer") != id(doc, "customer")
        {
            errors.push(FieldError::new("equipment", "belongs to another customer"));
        }
        if let Err(Error::Validation(e)) = coordinates(doc) {
            errors.extend(e);
        }
        // Time is recorded for the assigned technicians, each by themselves (dispatchers for anyone).
        let crew: Vec<Uuid> = rows(doc, "crew").iter().filter_map(|r| id(r, "technician")).collect();
        let me = if crate::is_dispatcher(hc.ctx) { None } else { Some(my_technician(hc.kernel, hc.ctx, hc.tx).await?.and_then(|t| id(&t, "id"))) };
        for (i, r) in rows(doc, "labour").iter().enumerate() {
            let before = row_by_id(old.as_ref(), "labour", r);
            let changed = before.as_ref().is_none_or(|o| ["technician", "from_time", "to_time", "billable"].iter().any(|f| o.get(*f) != r.get(*f)));
            if !changed {
                continue;
            }
            match id(r, "technician") {
                None => errors.push(FieldError::new("technician", "choose the technician").in_row("labour", i)),
                Some(t) if !crew.contains(&t) => {
                    errors.push(FieldError::new("technician", "is not assigned to this work order; schedule them first").in_row("labour", i))
                }
                Some(t) if me.as_ref().is_some_and(|m| *m != Some(t)) => {
                    errors.push(FieldError::new("technician", "you can only record your own time").in_row("labour", i))
                }
                _ => {}
            }
        }
        let signature = s(doc, "customer_signature");
        if let Some(sig) = signature
            && old.as_ref().is_none_or(|o| s(o, "customer_signature") != signature)
            && !signature_file_ok(hc, sig).await?
        {
            errors.push(FieldError::new("customer_signature", "must be an uploaded image (/files/<id> from /api/files)"));
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn before_submit(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let status = s(doc, "status").unwrap_or("New").to_string();
        if status != "On Site" {
            return Err(Error::invalid(format!("a work order is completed on site; it is {status} (arrive first)")));
        }
        let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
        let mut errors = Vec::new();
        if settings.require_checklist {
            for (i, r) in rows(doc, "checklist").iter().enumerate() {
                if b(r, "required") && !b(r, "done") {
                    errors.push(FieldError::new("done", format!("required task not done: {}", s(r, "task").unwrap_or_default())).in_row("checklist", i));
                }
            }
        }
        if settings.require_signature {
            if s(doc, "customer_signature").is_none() {
                errors.push(FieldError::new("customer_signature", "the customer's signature is required to complete the work order"));
            }
            if s(doc, "signed_by").is_none() {
                errors.push(FieldError::new("signed_by", "the name of the person who signed is required"));
            }
        }
        let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").ok_or_else(|| Error::field("company", "is required"))?).await?;
        errors.extend(check_stock(hc, &co, doc).await?);
        if !errors.is_empty() {
            return Err(Error::Validation(errors));
        }
        let now = Utc::now();
        let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
        let visits: i64 =
            sqlx::query_scalar("select count(*) from e_service_appointment where tenant_id = $1 and work_order = $2 and actual_start is not null")
                .bind(hc.ctx.tenant)
                .bind(wo)
                .fetch_one(&mut **hc.tx)
                .await?;
        set(doc, "status", "Completed");
        set(doc, "completed_at", ts_value(now));
        set(doc, "visits", visits);
        set(doc, "first_time_fix", visits == 1);
        let contract = contract_of(hc.kernel, hc.ctx, hc.tx, doc).await?;
        doc.extend(sla_fields(&settings, contract.as_ref(), doc, &hc.ctx.schema.timezone, now));
        Ok(())
    }

    async fn on_submit(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
        issue_parts(hc, doc).await?;
        appointment::close_for_completion(hc.kernel, hc.ctx, hc.tx, wo).await?;
        if let Some(e) = id(doc, "equipment") {
            let mut v = Doc::new();
            v.insert("last_service_date".into(), json!(hc.ctx.today().to_string()));
            hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "CustomerEquipment", e, v).await?;
        }
        refresh(hc.kernel, hc.ctx, hc.tx, wo, None).await?;
        let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
        if settings.auto_invoice {
            let fresh = get(hc.kernel, hc.ctx, hc.tx, "ServiceWorkOrder", wo).await?;
            // A configuration gap must not keep the technician from completing: say so instead.
            match invoice::lines(hc.kernel, hc.ctx, hc.tx, &fresh, &settings).await {
                Ok(lines) => {
                    invoice::insert(hc, &fresh, lines).await?;
                }
                Err(e) => {
                    let note = format!("{} was completed but not invoiced automatically: {e}", label(&fresh));
                    notify::user(hc.tx, hc.ctx.tenant, hc.ctx.user, &note, "ServiceWorkOrder", wo).await?;
                }
            }
        }
        Ok(())
    }

    async fn before_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if let Some(inv) = id(doc, "sales_invoice") {
            let number = linked(hc.kernel, hc.ctx, hc.tx, "SalesInvoice", inv).await?.and_then(|i| s(&i, "number").map(str::to_string));
            return Err(Error::invalid(format!("cancel or delete sales invoice {} first", number.unwrap_or_else(|| "(draft)".into()))));
        }
        Ok(())
    }

    /// Reverses a completion: the parts go back to stock (the Material Issue is cancelled).
    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
        if let Some(se) = id(doc, "stock_entry")
            && int(&get(hc.kernel, hc.ctx, hc.tx, "StockEntry", se).await?, "docstatus") == 1
        {
            hc.kernel.cancel_tx(&elevated(hc.ctx), hc.tx, "StockEntry", se, None).await?;
        }
        let mut v = Doc::new();
        v.insert("status".into(), json!("Cancelled"));
        v.insert("cancelled_at".into(), ts_value(Utc::now()));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceWorkOrder", wo, v).await
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
        let visits: i64 = sqlx::query_scalar("select count(*) from e_service_appointment where tenant_id = $1 and work_order = $2")
            .bind(hc.ctx.tenant)
            .bind(wo)
            .fetch_one(&mut **hc.tx)
            .await?;
        if visits > 0 {
            return Err(Error::invalid("this work order has appointments; cancel it instead of deleting it"));
        }
        // The request it came from can be converted again.
        if let Some(r) = id(doc, "service_request") {
            let mut v = Doc::new();
            v.insert("status".into(), json!("Open"));
            v.insert("work_order".into(), Value::Null);
            hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceRequest", r, v).await?;
        }
        Ok(())
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        let out = match name {
            "suggest_technicians" => dispatch::suggest(hc, doc, params).await?,
            "schedule" => appointment::schedule(hc, doc, params).await?,
            "dispatch" => appointment::advance(hc, doc, "Dispatched").await?,
            "start_travel" => appointment::advance(hc, doc, "En Route").await?,
            "arrive" => appointment::advance(hc, doc, "On Site").await?,
            "complete" => {
                let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
                let done = hc.kernel.submit_tx(hc.ctx, hc.tx, "ServiceWorkOrder", wo, None).await?;
                json!({"status": done.get("status"), "stock_entry": done.get("stock_entry"), "sales_invoice": done.get("sales_invoice"),
                       "first_time_fix": done.get("first_time_fix")})
            }
            "cancel_work_order" => cancel(hc, doc, params).await?,
            "create_invoice" => invoice::create(hc, doc).await?,
            _ => return Ok(None),
        };
        Ok(Some(out))
    }
}

/// Whether a `/files/<id>` value names an uploaded image of this workspace.
async fn signature_file_ok(hc: &mut HookCtx<'_>, value: &str) -> Result<bool> {
    let Some(file) = value.strip_prefix("/files/").and_then(|f| Uuid::try_parse(f).ok()) else { return Ok(false) };
    let ctype: Option<String> = sqlx::query_scalar("select content_type from file_object where tenant_id = $1 and id = $2")
        .bind(hc.ctx.tenant)
        .bind(file)
        .fetch_optional(&mut **hc.tx)
        .await?;
    Ok(ctype.is_some_and(|c| c.starts_with("image/")))
}

/// Parts of stock items need a warehouse, matching serial numbers and (unless the company allows
/// negative stock) enough stock. The stock engine checks again under its lock when posting;
/// this answers per row first.
async fn check_stock(hc: &mut HookCtx<'_>, co: &Company, doc: &Doc) -> Result<Vec<FieldError>> {
    let mut errors = Vec::new();
    let mut need: BTreeMap<(Uuid, Uuid), (Decimal, Vec<usize>)> = BTreeMap::new();
    for (i, r) in rows(doc, "parts").iter().enumerate() {
        let Some(item) = id(r, "item") else { continue };
        let it = get(hc.kernel, hc.ctx, hc.tx, "Item", item).await?;
        if !b(&it, "is_stock_item") {
            continue;
        }
        let Some(wh) = id(r, "warehouse") else {
            errors.push(FieldError::new("warehouse", "choose the warehouse the part comes from").in_row("parts", i));
            continue;
        };
        let serials = ferrum_domain::stock::parse_serials(s(r, "serial_no"));
        if b(&it, "has_serial_no") && Decimal::from(serials.len()) != d(r, "qty") {
            errors.push(
                FieldError::new(
                    "serial_no",
                    format!("{} is serialized: give {} serial number(s)", s(&it, "item_code").unwrap_or_default(), d(r, "qty").normalize()),
                )
                .in_row("parts", i),
            );
        }
        if b(&it, "has_batch_no") && s(r, "batch_no").is_none() {
            errors.push(FieldError::new("batch_no", "this item is batch-tracked: give the batch number").in_row("parts", i));
        }
        let e = need.entry((item, wh)).or_default();
        e.0 += d(r, "qty");
        e.1.push(i);
    }
    if co.allow_negative_stock {
        return Ok(errors);
    }
    for ((item, wh), (qty, idxs)) in need {
        let available: Option<Decimal> = sqlx::query_scalar("select qty from stock_balance where tenant_id = $1 and item_id = $2 and warehouse_id = $3")
            .bind(hc.ctx.tenant)
            .bind(item)
            .bind(wh)
            .fetch_optional(&mut **hc.tx)
            .await?;
        let available = available.unwrap_or_default();
        if available < qty {
            let w = get(hc.kernel, hc.ctx, hc.tx, "Warehouse", wh).await?;
            let msg =
                format!("not enough stock in {}: {} available, {} needed", s(&w, "warehouse_name").unwrap_or_default(), available.normalize(), qty.normalize());
            errors.extend(idxs.into_iter().map(|i| FieldError::new("qty", msg.clone()).in_row("parts", i)));
        }
    }
    Ok(errors)
}

/// The parts of stock items leave stock on a submitted Material Issue (valued by the stock
/// engine, offset to cost of goods sold); the issued value is written back to each part.
async fn issue_parts(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
    let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
    let co = company(hc.kernel, hc.ctx, hc.tx, id(doc, "company").ok_or_else(|| Error::field("company", "is required"))?).await?;
    let mut lines = Vec::new();
    let mut part_rows = Vec::new();
    for r in rows(doc, "parts") {
        let Some(item) = id(&r, "item") else { continue };
        if !b(&get(hc.kernel, hc.ctx, hc.tx, "Item", item).await?, "is_stock_item") {
            continue;
        }
        let mut line = json!({"item": item.to_string(), "qty": r.get("qty"), "source_warehouse": r.get("warehouse"),
                              "serial_no": r.get("serial_no"), "batch_no": r.get("batch_no")});
        if let Some(cogs) = co.account("cogs_account") {
            line["expense_account"] = json!(cogs.to_string());
        }
        lines.push(line);
        part_rows.push(id(&r, "id").ok_or_else(|| Error::internal("part without id"))?);
    }
    if lines.is_empty() {
        return Ok(());
    }
    let mut input = Doc::new();
    input.insert("company".into(), json!(co.id.to_string()));
    input.insert("purpose".into(), json!("Material Issue"));
    input.insert("posting_date".into(), json!(hc.ctx.today().to_string()));
    input.insert("posting_time".into(), json!(hc.ctx.now_local().format("%H:%M:%S").to_string()));
    input.insert("remarks".into(), json!(format!("Parts used on service work order {}", label(doc))));
    input.insert("items".into(), Value::Array(lines));
    // The technician needs no stock rights: the engine posts for them, in their name.
    let ectx = elevated(hc.ctx);
    let draft = hc.kernel.insert_tx(&ectx, hc.tx, "StockEntry", input).await?;
    let se = id(&draft, "id").ok_or_else(|| Error::internal("stock entry without id"))?;
    let posted = hc.kernel.submit_tx(&ectx, hc.tx, "StockEntry", se, None).await?;
    let sctx = sys(hc.ctx);
    let mut total = Decimal::ZERO;
    for (part, line) in part_rows.iter().zip(rows(&posted, "items")) {
        let mut v = Doc::new();
        v.insert("cost".into(), money(d(&line, "amount")));
        total += d(&line, "amount");
        hc.kernel.set_child_values_tx(&sctx, hc.tx, "ServiceWorkOrder", "parts", *part, v).await?;
    }
    let mut v = Doc::new();
    v.insert("stock_entry".into(), json!(se.to_string()));
    v.insert("parts_cost".into(), money(total));
    hc.kernel.set_values_tx(&sctx, hc.tx, "ServiceWorkOrder", wo, v).await
}

/// `cancel_work_order`: the job will not be done. Open appointments are cancelled (freeing the
/// technicians' time) and the SLA clock stops.
async fn cancel(hc: &mut HookCtx<'_>, doc: &Doc, params: &Value) -> Result<Value> {
    require_dispatcher(hc.ctx, "cancel work orders")?;
    let wo = id(doc, "id").ok_or_else(|| Error::internal("work order without id"))?;
    let reason = params.get("reason").and_then(Value::as_str).map(str::trim).filter(|r| !r.is_empty());
    if reason.is_some_and(|r| r.chars().count() > 2000) {
        return Err(Error::field("reason", "at most 2000 characters"));
    }
    let told = appointment::cancel_open(hc.kernel, hc.ctx, hc.tx, wo).await?;
    let mut v = Doc::new();
    v.insert("status".into(), json!("Cancelled"));
    v.insert("cancelled_at".into(), ts_value(Utc::now()));
    v.insert("cancellation_reason".into(), json!(reason));
    hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceWorkOrder", wo, v).await?;
    refresh(hc.kernel, hc.ctx, hc.tx, wo, None).await?;
    notify::emails(hc.tx, hc.ctx.tenant, &told, &format!("{} was cancelled", label(doc)), "ServiceWorkOrder", wo).await?;
    Ok(json!({"status": "Cancelled"}))
}

// ───────────────────────────── refresh ─────────────────────────────

/// Re-derives what follows from a work order's appointments and the clock: the crew (everyone on
/// a non-cancelled appointment, who then sees the work order), the current appointment and its
/// times, the status of an open work order (the most advanced active appointment; New without
/// one) and the SLA verdict. Only changed values are written, without a new version. `exclude`
/// leaves out an appointment about to be deleted.
pub async fn refresh(k: &Kernel, ctx: &Ctx, tx: &mut Tx, wo: Uuid, exclude: Option<Uuid>) -> Result<()> {
    let sctx = sys(ctx);
    // Locked: refreshes of one work order queue, so its crew is never written twice at once.
    let doc = k.get_tx(&sctx, tx, "ServiceWorkOrder", wo, true).await?;
    let visits = appointment::of_work_order(tx, ctx, wo, exclude).await?;

    let mut crew: Vec<(Uuid, Option<String>, Option<String>)> = Vec::new();
    for v in visits.iter().filter(|v| v.status != "Cancelled") {
        for t in &v.technicians {
            if !crew.iter().any(|c| c.0 == t.0) {
                crew.push(t.clone());
            }
        }
    }
    let stored: Vec<(Uuid, Option<String>, Option<String>)> = rows(&doc, "crew")
        .iter()
        .filter_map(|r| Some((id(r, "technician")?, s(r, "technician_name").map(str::to_string), s(r, "user_email").map(str::to_string))))
        .collect();
    if stored != crew {
        let table = child_table(ctx, "ServiceWorkOrder", "crew")?;
        sqlx::query(sqlx::AssertSqlSafe(format!("delete from {table} where tenant_id = $1 and parent_id = $2")))
            .bind(ctx.tenant)
            .bind(wo)
            .execute(&mut **tx)
            .await?;
        let ids: Vec<Uuid> = crew.iter().map(|_| Uuid::now_v7()).collect();
        let idx: Vec<i32> = (0..crew.len() as i32).collect();
        let techs: Vec<Uuid> = crew.iter().map(|c| c.0).collect();
        let names: Vec<Option<String>> = crew.iter().map(|c| c.1.clone()).collect();
        let emails: Vec<Option<String>> = crew.iter().map(|c| c.2.clone()).collect();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "insert into {table} (tenant_id, id, parent_id, idx, technician, technician_name, user_email) \
             select $1, x.id, $2, x.idx, x.t, x.n, x.e from unnest($3::uuid[], $4::int[], $5::uuid[], $6::text[], $7::text[]) as x(id, idx, t, n, e)"
        )))
        .bind(ctx.tenant)
        .bind(wo)
        .bind(&ids)
        .bind(&idx)
        .bind(&techs)
        .bind(&names)
        .bind(&emails)
        .execute(&mut **tx)
        .await?;
    }

    let rank = |st: &str| appointment::ACTIVE.iter().position(|a| *a == st);
    let current = visits.iter().filter(|v| rank(&v.status).is_some()).max_by(|a, b| rank(&a.status).cmp(&rank(&b.status)).then(b.start.cmp(&a.start)));
    let shown = current.or_else(|| if int(&doc, "docstatus") == 1 { visits.iter().filter(|v| v.status != "Cancelled").max_by_key(|v| v.start) } else { None });
    let mut values = Doc::new();
    values.insert("current_appointment".into(), shown.map_or(Value::Null, |v| json!(v.id.to_string())));
    values.insert("scheduled_start".into(), opt_ts(shown.map(|v| v.start)));
    values.insert("scheduled_end".into(), opt_ts(shown.map(|v| v.end)));
    if int(&doc, "docstatus") == 0 && s(&doc, "status") != Some("Cancelled") {
        values.insert("status".into(), json!(current.map_or("New", |v| v.status.as_str())));
    }
    if int(&doc, "docstatus") == 0 {
        let settings = Settings::load(k, ctx, tx).await?;
        let contract = contract_of(k, ctx, tx, &doc).await?;
        let mut merged = doc.clone();
        merged.extend(values.clone());
        values.extend(sla_fields(&settings, contract.as_ref(), &merged, &ctx.schema.timezone, Utc::now()));
    }
    let changed = delta(&doc, values);
    if !changed.is_empty() {
        k.set_values_tx(&sctx, tx, "ServiceWorkOrder", wo, changed).await?;
    }
    Ok(())
}

/// Maintenance: SLA verdicts move with time. Open work orders past a quarter-left point of a
/// pending deadline are re-judged under their row lock; a new breach is announced to the crew
/// and the work order's creator and published as `ServiceWorkOrder.updated` (automations,
/// webhooks). Safe on several replicas at once.
pub async fn refresh_slas(k: &Kernel, ctx: &Ctx) -> Result<usize> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_service_work_order where tenant_id = $1 and docstatus = 0 and status <> 'Cancelled' and sla_start is not null and ( \
           (arrived_at is null and not response_breached and response_due - (response_due - sla_start) / 4 <= now()) \
           or (completed_at is null and not resolution_breached and resolution_due - (resolution_due - sla_start) / 4 <= now())) \
         order by id limit 5000",
    )
    .bind(ctx.tenant)
    .fetch_all(&mut *tx)
    .await?;
    let settings = Settings::load(k, ctx, &mut tx).await?;
    tx.commit().await?;
    let ent = k.entity(ctx, "ServiceWorkOrder")?;
    let mut changed = 0;
    for chunk in ids.chunks(100) {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        for &wo in chunk {
            let Some(doc) = ferrum_kernel::store::load(&mut tx, &ctx.schema, &ent, ctx.tenant, wo, true).await? else { continue };
            if int(&doc, "docstatus") != 0 || !s(&doc, "status").is_some_and(|st| OPEN.contains(&st)) {
                continue;
            }
            let contract = contract_of(k, ctx, &mut tx, &doc).await?;
            let values = delta(&doc, sla_fields(&settings, contract.as_ref(), &doc, &ctx.schema.timezone, Utc::now()));
            if values.is_empty() {
                continue;
            }
            let breached = values.get("sla_status") == Some(&json!("Breached"));
            k.set_values_tx(ctx, &mut tx, "ServiceWorkOrder", wo, values).await?;
            if breached {
                let title = format!("SLA breached on {}", label(&doc));
                let crew: Vec<String> = rows(&doc, "crew").iter().filter_map(|r| s(r, "user_email").map(str::to_string)).collect();
                notify::emails(&mut tx, ctx.tenant, &crew, &title, "ServiceWorkOrder", wo).await?;
                if let Some(creator) = id(&doc, "created_by") {
                    notify::user(&mut tx, ctx.tenant, creator, &title, "ServiceWorkOrder", wo).await?;
                }
            }
            let fresh = ferrum_kernel::store::load(&mut tx, &ctx.schema, &ent, ctx.tenant, wo, false).await?;
            let payload = json!({"entity": "ServiceWorkOrder", "id": wo, "event": "updated", "actor": Value::Null, "depth": ctx.depth,
                                 "request_id": ctx.request_id, "doc": fresh});
            outbox::enqueue(&mut tx, ctx.tenant, "ServiceWorkOrder.updated", Some("ServiceWorkOrder"), Some(wo), payload).await?;
            changed += 1;
        }
        tx.commit().await?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn settings() -> Settings {
        let mut sla = HashMap::new();
        sla.insert("High".to_string(), (Decimal::from(4), Decimal::from(24)));
        Settings {
            labour_item: None,
            expense_item: None,
            labour_step: 1,
            speed_kmh: Decimal::from(40),
            default_duration: 60,
            default_warehouse: None,
            require_checklist: true,
            require_signature: true,
            auto_invoice: false,
            notify_customer: true,
            public_requests: false,
            tracking_days: 30,
            sla,
            default_hours: vec![],
        }
    }

    fn doc(v: Value) -> Doc {
        v.as_object().cloned().unwrap()
    }

    fn t(s: &str) -> Ts {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn targets_come_from_the_contract_else_the_priority() {
        let wo = doc(json!({"priority": "High", "reported_at": "2026-11-02T08:00:00.000Z"}));
        let f = sla_fields(&settings(), None, &wo, "UTC", t("2026-11-02T09:00:00Z"));
        assert_eq!(
            (f["response_due"].clone(), f["resolution_due"].clone(), f["sla_status"].clone()),
            (json!("2026-11-02T12:00:00.000Z"), json!("2026-11-03T08:00:00.000Z"), json!("On Track"))
        );
        let contract = doc(json!({"sla_response_hours": "2", "sla_resolution_hours": "0"}));
        let f = sla_fields(&settings(), Some(&contract), &wo, "UTC", t("2026-11-02T10:30:00Z"));
        assert_eq!((f["response_hours"].clone(), f["resolution_hours"].clone()), (json!("2"), json!("24")), "0 falls back to the priority");
        assert_eq!((f["response_breached"].clone(), f["sla_status"].clone()), (json!(true), json!("Breached")));
        let low = doc(json!({"priority": "Low", "reported_at": "2026-11-02T08:00:00.000Z"}));
        let none = sla_fields(&settings(), None, &low, "UTC", t("2026-11-09T09:00:00Z"));
        assert_eq!((none["sla_status"].clone(), none["response_breached"].clone()), (Value::Null, json!(false)), "no target, no verdict");
        // A planned visit's clock starts on its due day, in the workspace's zone.
        let planned = doc(json!({"priority": "High", "reported_at": "2026-10-20T08:00:00.000Z", "contract_due_date": "2026-11-02"}));
        let f = sla_fields(&settings(), None, &planned, "Asia/Kolkata", t("2026-11-01T00:00:00Z"));
        assert_eq!(f["sla_start"], json!("2026-11-01T18:30:00.000Z"));
        // Cancelling stops the clock.
        let cancelled = doc(json!({"priority": "High", "reported_at": "2026-11-02T08:00:00.000Z", "cancelled_at": "2026-11-02T09:00:00.000Z"}));
        assert_eq!(sla_fields(&settings(), None, &cancelled, "UTC", t("2026-11-05T00:00:00Z"))["sla_status"], json!("On Track"));
        assert_eq!(Decimal::from_str("4").unwrap(), settings().sla["High"].0);
    }
}
