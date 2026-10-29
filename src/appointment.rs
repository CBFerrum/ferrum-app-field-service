//! Service appointments: visits of one or more technicians. Active appointments (scheduled,
//! dispatched, en route, on site) reserve the technicians' time: the rows carry the slot and a
//! `busy` flag, and an exclusion constraint makes two busy rows of one technician overlapping
//! impossible. Bookings of a technician also queue on an advisory lock first, so a refused one is
//! told which appointment is in the way. The work order's status follows its appointments.

use crate::logic::Ts;
use crate::setup::Settings;
use crate::work_order::{self, OPEN, label};
use crate::{child_table, is_dispatcher, linked, notify, require_dispatcher, stored, ts, ts_value};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use ferrum_domain::flow::created;
use ferrum_domain::util::{get, id, rows, s, set, sys};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, FieldError, HookCtx, Kernel, Result, Tx};
use serde_json::{Value, json};
use std::collections::HashSet;
use uuid::Uuid;

/// Statuses that reserve the technicians' time, least advanced first.
pub const ACTIVE: [&str; 4] = ["Scheduled", "Dispatched", "En Route", "On Site"];

/// An appointment is at most this long (a multi-day installation is one appointment).
const MAX_DAYS: i64 = 31;

/// One visit of a work order with its technicians `(technician, name, user email)`.
#[derive(Debug, Clone)]
pub struct Visit {
    pub id: Uuid,
    pub status: String,
    pub start: Ts,
    pub end: Ts,
    pub technicians: Vec<(Uuid, Option<String>, Option<String>)>,
}

pub async fn of_work_order(tx: &mut Tx, ctx: &Ctx, wo: Uuid, exclude: Option<Uuid>) -> Result<Vec<Visit>> {
    let table = child_table(ctx, "ServiceAppointment", "technicians")?;
    let found: Vec<(Uuid, String, Ts, Ts, Option<Uuid>, Option<String>, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select a.id, a.status, a.scheduled_start, a.scheduled_end, t.technician, t.technician_name, t.user_email \
         from e_service_appointment a left join {table} t on t.tenant_id = a.tenant_id and t.parent_id = a.id \
         where a.tenant_id = $1 and a.work_order = $2 and ($3::uuid is null or a.id <> $3) order by a.scheduled_start, a.id, t.idx"
    )))
    .bind(ctx.tenant)
    .bind(wo)
    .bind(exclude)
    .fetch_all(&mut **tx)
    .await?;
    let mut out: Vec<Visit> = Vec::new();
    for (aid, status, start, end, tech, name, email) in found {
        if out.last().is_none_or(|v| v.id != aid) {
            out.push(Visit { id: aid, status, start, end, technicians: vec![] });
        }
        if let (Some(v), Some(t)) = (out.last_mut(), tech) {
            v.technicians.push((t, name, email));
        }
    }
    Ok(out)
}

fn technician_ids(doc: &Doc) -> Vec<Option<Uuid>> {
    rows(doc, "technicians").iter().map(|r| id(r, "technician")).collect()
}

/// `Mon 2 Nov 10:00–12:00` in the workspace's time zone.
pub fn window(ctx: &Ctx, start: Ts, end: Ts) -> String {
    let tz = crate::logic::zone(None, &ctx.schema.timezone);
    let (a, z) = (start.with_timezone(&tz), end.with_timezone(&tz));
    if a.date_naive() == z.date_naive() {
        format!("{} {}–{}", a.format("%a %-d %b"), a.format("%H:%M"), z.format("%H:%M"))
    } else {
        format!("{} {} – {} {}", a.format("%a %-d %b"), a.format("%H:%M"), z.format("%a %-d %b"), z.format("%H:%M"))
    }
}

/// Sets an appointment's status (and timestamps) and releases or keeps its technicians' time.
pub async fn set_status(k: &Kernel, ctx: &Ctx, tx: &mut Tx, appointment: Uuid, status: &str, extra: Doc) -> Result<()> {
    let mut values = extra;
    values.insert("status".into(), json!(status));
    k.set_values_tx(&sys(ctx), tx, "ServiceAppointment", appointment, values).await?;
    let table = child_table(ctx, "ServiceAppointment", "technicians")?;
    sqlx::query(sqlx::AssertSqlSafe(format!("update {table} set busy = $3, updated_at = now() where tenant_id = $1 and parent_id = $2 and busy <> $3")))
        .bind(ctx.tenant)
        .bind(appointment)
        .bind(ACTIVE.contains(&status))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Queues bookings of the same technicians (sorted, so two bookings never wait on each other),
/// then names the active appointments in the way. The exclusion constraint stays the guarantee.
async fn check_free(hc: &mut HookCtx<'_>, doc: &Doc, start: Ts, end: Ts) -> Result<Vec<FieldError>> {
    let mut techs: Vec<Uuid> = rows(doc, "technicians").iter().filter_map(|r| id(r, "technician")).collect();
    techs.sort();
    techs.dedup();
    for t in &techs {
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('ferrum:field_service:technician:' || $1::text || ':' || $2::text, 0))")
            .bind(hc.ctx.tenant)
            .bind(t)
            .execute(&mut **hc.tx)
            .await?;
    }
    let table = child_table(hc.ctx, "ServiceAppointment", "technicians")?;
    let clashes: Vec<(Uuid, String, Ts, Ts)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select t.technician, coalesce(a.number, a.id::text), t.slot_start, t.slot_end from {table} t \
         join e_service_appointment a on a.tenant_id = t.tenant_id and a.id = t.parent_id \
         where t.tenant_id = $1 and t.busy and t.technician = any($2) and t.parent_id <> $3 \
         and tstzrange(t.slot_start, t.slot_end, '[)') && tstzrange($4, $5, '[)') order by t.slot_start"
    )))
    .bind(hc.ctx.tenant)
    .bind(&techs)
    .bind(id(doc, "id"))
    .bind(start)
    .bind(end)
    .fetch_all(&mut **hc.tx)
    .await?;
    let mut errors = Vec::new();
    for (i, r) in rows(doc, "technicians").iter().enumerate() {
        if let Some((_, number, a, z)) = clashes.iter().find(|c| Some(c.0) == id(r, "technician")) {
            let who = s(r, "technician_name").unwrap_or("the technician");
            errors.push(FieldError::new("technician", format!("{who} is already booked {} on {number}", window(hc.ctx, *a, *z))).in_row("technicians", i));
        }
    }
    Ok(errors)
}

pub struct AppointmentHook;

#[async_trait]
impl DocHook for AppointmentHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let old = stored(hc, doc).await?;
        if let Some(o) = &old {
            if o.get("work_order") != doc.get("work_order") {
                return Err(Error::field("work_order", "cannot change; cancel this appointment and schedule the other work order"));
            }
            let moved = ["scheduled_start", "scheduled_end"].iter().any(|f| o.get(*f) != doc.get(*f)) || technician_ids(o) != technician_ids(doc);
            match (moved, s(o, "status").unwrap_or("Scheduled")) {
                (false, _) | (true, "Scheduled") => {}
                // Changed after dispatch: it has to be dispatched again.
                (true, "Dispatched") => set(doc, "status", "Scheduled"),
                (true, other) => {
                    return Err(Error::invalid(format!(
                        "an appointment that is {} cannot be moved; schedule a new visit from the work order",
                        other.to_lowercase()
                    )));
                }
            }
        }
        let busy = ACTIVE.contains(&s(doc, "status").unwrap_or("Scheduled"));
        let (start, end) = (doc.get("scheduled_start").cloned().unwrap_or(Value::Null), doc.get("scheduled_end").cloned().unwrap_or(Value::Null));
        let technicians: Vec<Value> = rows(doc, "technicians")
            .into_iter()
            .map(|mut r| {
                r.insert("slot_start".into(), start.clone());
                r.insert("slot_end".into(), end.clone());
                r.insert("busy".into(), json!(busy));
                Value::Object(r)
            })
            .collect();
        set(doc, "technicians", Value::Array(technicians));
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let old = stored(hc, doc).await?;
        let (Some(start), Some(end)) = (ts(doc, "scheduled_start"), ts(doc, "scheduled_end")) else { return Ok(()) };
        let mut errors = Vec::new();
        if end <= start {
            return Err(Error::field("scheduled_end", "must be after the start"));
        }
        if end - start > Duration::days(MAX_DAYS) {
            errors.push(FieldError::new("scheduled_end", format!("an appointment lasts at most {MAX_DAYS} days")));
        }
        // The work order first, then the technicians: the order the work order's actions lock in.
        let wo = match id(doc, "work_order") {
            Some(w) => Some(hc.kernel.get_tx(&sys(hc.ctx), hc.tx, "ServiceWorkOrder", w, true).await?),
            None => None,
        };
        if old.is_none()
            && let Some(w) = &wo
            && (crate::int(w, "docstatus") != 0 || !s(w, "status").is_some_and(|st| OPEN.contains(&st)))
        {
            errors.push(FieldError::new(
                "work_order",
                format!("is {}; only open work orders get appointments", s(w, "status").unwrap_or_default().to_lowercase()),
            ));
        }
        let known: HashSet<Option<Uuid>> = old.as_ref().map(|o| technician_ids(o).into_iter().collect()).unwrap_or_default();
        let mut seen = HashSet::new();
        for (i, r) in rows(doc, "technicians").iter().enumerate() {
            let Some(t) = id(r, "technician") else { continue };
            if !seen.insert(t) {
                errors.push(FieldError::new("technician", "is listed twice").in_row("technicians", i));
            } else if !known.contains(&Some(t))
                && let Some(tech) = linked(hc.kernel, hc.ctx, hc.tx, "Technician", t).await?
                && !ferrum_domain::util::b(&tech, "active")
            {
                errors.push(FieldError::new("technician", "is inactive").in_row("technicians", i));
            }
        }
        if !errors.is_empty() {
            return Err(Error::Validation(errors));
        }
        if ACTIVE.contains(&s(doc, "status").unwrap_or("Scheduled")) {
            let clashes = check_free(hc, doc, start, end).await?;
            if !clashes.is_empty() {
                return Err(Error::Validation(clashes));
            }
        }
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        match id(doc, "work_order") {
            Some(wo) => work_order::refresh(hc.kernel, hc.ctx, hc.tx, wo, None).await,
            None => Ok(()),
        }
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if !matches!(s(doc, "status"), Some("Scheduled" | "Cancelled")) {
            return Err(Error::invalid("only appointments not yet dispatched (or cancelled ones) can be deleted; cancel it instead"));
        }
        match (id(doc, "work_order"), id(doc, "id")) {
            (Some(wo), Some(me)) => work_order::refresh(hc.kernel, hc.ctx, hc.tx, wo, Some(me)).await,
            _ => Ok(()),
        }
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        if name != "cancel_appointment" {
            return Ok(None);
        }
        require_dispatcher(hc.ctx, "cancel appointments")?;
        let appt = id(doc, "id").ok_or_else(|| Error::internal("appointment without id"))?;
        let was = s(doc, "status").unwrap_or_default().to_string();
        set_status(hc.kernel, hc.ctx, hc.tx, appt, "Cancelled", Doc::new()).await?;
        if let Some(wo) = id(doc, "work_order") {
            work_order::refresh(hc.kernel, hc.ctx, hc.tx, wo, None).await?;
            if was != "Scheduled" {
                let w = get(hc.kernel, hc.ctx, hc.tx, "ServiceWorkOrder", wo).await?;
                let title = format!("Visit for {} on {} was cancelled", label(&w), window_of(hc.ctx, doc));
                notify::emails(hc.tx, hc.ctx.tenant, &emails(doc), &title, "ServiceWorkOrder", wo).await?;
            }
        }
        Ok(Some(json!({"status": "Cancelled"})))
    }
}

fn emails(doc: &Doc) -> Vec<String> {
    rows(doc, "technicians").iter().filter_map(|r| s(r, "user_email").map(str::to_string)).collect()
}

fn window_of(ctx: &Ctx, doc: &Doc) -> String {
    match (ts(doc, "scheduled_start"), ts(doc, "scheduled_end")) {
        (Some(a), Some(z)) => window(ctx, a, z),
        _ => String::new(),
    }
}

pub(crate) fn param_ts(params: &Value, key: &str) -> Result<Option<Ts>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) => ferrum_kernel::value::parse_datetime(v).map(Some).map_err(|m| Error::field(key, m)),
        Some(_) => Err(Error::field(key, "must be a date-time (RFC 3339)")),
    }
}

/// `schedule` on a work order: `{technicians: [id] | technician: id, start, end? | duration_minutes?,
/// notes?}`. Moves the current appointment while it is only scheduled or dispatched; when a
/// technician is already on the way or on site, that visit ends (Cannot Complete) and a new one is
/// planned (a revisit); otherwise a new appointment is made.
pub async fn schedule(hc: &mut HookCtx<'_>, wo: &Doc, params: &Value) -> Result<Value> {
    require_dispatcher(hc.ctx, "schedule work orders")?;
    let wo_id = id(wo, "id").ok_or_else(|| Error::internal("work order without id"))?;
    let status = s(wo, "status").unwrap_or("New");
    if !OPEN.contains(&status) {
        return Err(Error::invalid(format!("a work order that is {} cannot be scheduled", status.to_lowercase())));
    }
    let technicians: Vec<Uuid> = match (params.get("technicians"), params.get("technician")) {
        (Some(Value::Array(list)), _) => list
            .iter()
            .map(|v| v.as_str().and_then(|x| x.parse().ok()).ok_or_else(|| Error::field("technicians", "must be a list of technician ids")))
            .collect::<Result<_>>()?,
        (_, Some(Value::String(t))) => vec![t.parse().map_err(|_| Error::field("technician", "is not a technician id"))?],
        _ => vec![],
    };
    if technicians.is_empty() || technicians.len() > 20 {
        return Err(Error::field("technicians", "choose one to 20 technicians"));
    }
    let start = param_ts(params, "start")?.ok_or_else(|| Error::field("start", "is required (RFC 3339 date-time)"))?;
    let end = match param_ts(params, "end")? {
        Some(e) => e,
        None => {
            let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
            let minutes = match params.get("duration_minutes") {
                Some(v) if !v.is_null() => {
                    v.as_i64().filter(|m| (1..=MAX_DAYS * 1440).contains(m)).ok_or_else(|| Error::field("duration_minutes", "must be a number of minutes"))?
                }
                _ => Some(crate::int(wo, "estimated_duration_minutes")).filter(|m| *m > 0).unwrap_or(settings.default_duration),
            };
            start + Duration::minutes(minutes)
        }
    };
    let notes = params.get("notes").and_then(Value::as_str).map(str::to_string);
    let current = match id(wo, "current_appointment") {
        Some(a) => linked(hc.kernel, hc.ctx, hc.tx, "ServiceAppointment", a).await?,
        None => None,
    };
    let row_for = |existing: Option<&Doc>, t: &Uuid| {
        let keep = existing.and_then(|e| rows(e, "technicians").into_iter().find(|r| id(r, "technician") == Some(*t)));
        match keep.and_then(|r| r.get("id").cloned()) {
            Some(rid) => json!({"id": rid, "technician": t.to_string()}),
            None => json!({"technician": t.to_string()}),
        }
    };
    let mut fields = Doc::new();
    fields.insert("scheduled_start".into(), ts_value(start));
    fields.insert("scheduled_end".into(), ts_value(end));
    if let Some(n) = &notes {
        fields.insert("notes".into(), json!(n));
    }
    let movable = current.as_ref().filter(|c| matches!(s(c, "status"), Some("Scheduled" | "Dispatched")));
    let appointment = match movable {
        Some(c) => {
            let cid = id(c, "id").ok_or_else(|| Error::internal("appointment without id"))?;
            fields.insert("technicians".into(), Value::Array(technicians.iter().map(|t| row_for(Some(c), t)).collect()));
            hc.kernel.update_tx(hc.ctx, hc.tx, "ServiceAppointment", cid, fields, None).await?
        }
        None => {
            if let Some(c) = current.as_ref().filter(|c| matches!(s(c, "status"), Some("En Route" | "On Site"))) {
                // The job is not finished on this visit: it ends now and another one is planned.
                let mut ended = Doc::new();
                ended.insert("actual_end".into(), ts_value(Utc::now()));
                set_status(hc.kernel, hc.ctx, hc.tx, id(c, "id").unwrap_or_default(), "Cannot Complete", ended).await?;
            }
            fields.insert("work_order".into(), json!(wo_id.to_string()));
            fields.insert("technicians".into(), Value::Array(technicians.iter().map(|t| row_for(None, t)).collect()));
            hc.kernel.insert_tx(hc.ctx, hc.tx, "ServiceAppointment", fields).await?
        }
    };
    let now = get(hc.kernel, hc.ctx, hc.tx, "ServiceWorkOrder", wo_id).await?;
    let mut out = created("ServiceAppointment", &appointment);
    out["scheduled_start"] = appointment.get("scheduled_start").cloned().unwrap_or(Value::Null);
    out["scheduled_end"] = appointment.get("scheduled_end").cloned().unwrap_or(Value::Null);
    out["appointment_status"] = appointment.get("status").cloned().unwrap_or(Value::Null);
    out["status"] = now.get("status").cloned().unwrap_or(Value::Null);
    Ok(out)
}

/// The crew of a work order, or a dispatcher, may move it along.
fn require_crew_or_dispatcher(ctx: &Ctx, wo: &Doc) -> Result<()> {
    let me = ctx.email.to_lowercase();
    if is_dispatcher(ctx) || rows(wo, "crew").iter().any(|r| s(r, "user_email") == Some(me.as_str())) {
        Ok(())
    } else {
        Err(Error::Forbidden("you are not assigned to this work order".into()))
    }
}

/// `dispatch` (Scheduled → Dispatched; dispatchers), `start_travel` (→ En Route) and `arrive`
/// (→ On Site; the crew or a dispatcher). The current appointment moves and the work order
/// follows; the first arrival meets (or misses) the response target.
pub async fn advance(hc: &mut HookCtx<'_>, wo: &Doc, to: &str) -> Result<Value> {
    if to == "Dispatched" {
        require_dispatcher(hc.ctx, "dispatch work orders")?;
    } else {
        require_crew_or_dispatcher(hc.ctx, wo)?;
    }
    let wo_id = id(wo, "id").ok_or_else(|| Error::internal("work order without id"))?;
    let appt_id = id(wo, "current_appointment").ok_or_else(|| Error::invalid("schedule the work order first"))?;
    let appt = hc.kernel.get_tx(&sys(hc.ctx), hc.tx, "ServiceAppointment", appt_id, true).await?;
    let from = s(&appt, "status").unwrap_or_default().to_string();
    let allowed = matches!((from.as_str(), to), ("Scheduled", "Dispatched") | ("Dispatched", "En Route") | ("Dispatched" | "En Route", "On Site"));
    if !allowed {
        return Err(Error::invalid(format!("the appointment is {}; it cannot become {}", from.to_lowercase(), to.to_lowercase())));
    }
    let now = Utc::now();
    let mut stamps = Doc::new();
    let mut wo_stamps = Doc::new();
    match to {
        "En Route" => {
            stamps.insert("travel_started_at".into(), ts_value(now));
            if s(wo, "travel_started_at").is_none() {
                wo_stamps.insert("travel_started_at".into(), ts_value(now));
            }
        }
        "On Site" => {
            stamps.insert("actual_start".into(), ts_value(now));
            if s(wo, "arrived_at").is_none() {
                wo_stamps.insert("arrived_at".into(), ts_value(now));
            }
        }
        _ => {}
    }
    set_status(hc.kernel, hc.ctx, hc.tx, appt_id, to, stamps).await?;
    if !wo_stamps.is_empty() {
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceWorkOrder", wo_id, wo_stamps).await?;
    }
    work_order::refresh(hc.kernel, hc.ctx, hc.tx, wo_id, None).await?;
    let fresh = get(hc.kernel, hc.ctx, hc.tx, "ServiceWorkOrder", wo_id).await?;
    let when = window_of(hc.ctx, &appt);
    let mut emailed = false;
    match to {
        "Dispatched" => {
            let title = format!("{} dispatched to you: {when}", label(&fresh));
            notify::emails(hc.tx, hc.ctx.tenant, &emails(&appt), &title, "ServiceWorkOrder", wo_id).await?;
            let first: Vec<String> = rows(&appt, "technicians").iter().filter_map(|r| s(r, "technician_name").map(first_name)).collect();
            let message =
                format!("Your service visit is scheduled for {when} with {}.", if first.is_empty() { "our technician".into() } else { first.join(" and ") });
            emailed = tell_customer(hc.kernel, hc.ctx, hc.tx, &fresh, "Your service visit is scheduled", &message).await?;
        }
        "En Route" => {
            let who = rows(&appt, "technicians").iter().find_map(|r| s(r, "technician_name").map(first_name)).unwrap_or_else(|| "Your technician".into());
            emailed = tell_customer(hc.kernel, hc.ctx, hc.tx, &fresh, "Your technician is on the way", &format!("{who} is on the way to you now.")).await?;
        }
        _ => {}
    }
    Ok(json!({"status": fresh.get("status"), "appointment": appt_id.to_string(), "customer_emailed": emailed}))
}

/// Customers see technicians by first name only.
pub fn first_name(full: &str) -> String {
    full.split_whitespace().next().unwrap_or_default().to_string()
}

/// Emails the work order's contact (or its request's, or the customer's) when the settings say
/// so and the Mail app is installed, with a tracking link when the job came from a request.
async fn tell_customer(k: &Kernel, ctx: &Ctx, tx: &mut Tx, wo: &Doc, subject: &str, message: &str) -> Result<bool> {
    let settings = Settings::load(k, ctx, tx).await?;
    if !settings.notify_customer || !ctx.schema.packages.iter().any(|p| p == "comms") {
        return Ok(false);
    }
    let request = match id(wo, "service_request") {
        Some(r) => linked(k, ctx, tx, "ServiceRequest", r).await?,
        None => None,
    };
    let customer = match id(wo, "customer") {
        Some(c) => linked(k, ctx, tx, "Customer", c).await?,
        None => None,
    };
    let to = s(wo, "contact_email")
        .or_else(|| request.as_ref().and_then(|r| s(r, "contact_email")))
        .or_else(|| customer.as_ref().and_then(|c| s(c, "email")))
        .map(str::to_string);
    let Some(to) = to else { return Ok(false) };
    let link = match request.as_ref().and_then(|r| id(r, "id")) {
        Some(r) => crate::request::tracking_link(ctx, tx, r, settings.tracking_days).await?.1,
        None => None,
    };
    let mut html = format!("<p>{}</p><p>Reference: {}</p>", notify::escape(message), notify::escape(s(wo, "number").unwrap_or_default()));
    if let Some(url) = link {
        html.push_str(&format!("<p><a href=\"{u}\">Follow your service visit</a></p>", u = notify::escape(&url)));
    }
    let wo_id = id(wo, "id").ok_or_else(|| Error::internal("work order without id"))?;
    notify::email_customer(k, ctx, tx, &to, subject, &html, ("ServiceWorkOrder", wo_id)).await
}

/// On completion the visit on site ends now; other visits still planned are no longer needed.
pub async fn close_for_completion(k: &Kernel, ctx: &Ctx, tx: &mut Tx, wo: Uuid) -> Result<()> {
    let now = Utc::now();
    for v in of_work_order(tx, ctx, wo, None).await? {
        match v.status.as_str() {
            "On Site" => {
                let mut ended = Doc::new();
                ended.insert("actual_end".into(), ts_value(now));
                set_status(k, ctx, tx, v.id, "Completed", ended).await?;
            }
            st if ACTIVE.contains(&st) => set_status(k, ctx, tx, v.id, "Cancelled", Doc::new()).await?,
            _ => {}
        }
    }
    Ok(())
}

/// Cancels a work order's active appointments; returns the emails of technicians who had been
/// dispatched (they are told).
pub async fn cancel_open(k: &Kernel, ctx: &Ctx, tx: &mut Tx, wo: Uuid) -> Result<Vec<String>> {
    let mut told = Vec::new();
    for v in of_work_order(tx, ctx, wo, None).await? {
        if !ACTIVE.contains(&v.status.as_str()) {
            continue;
        }
        if v.status != "Scheduled" {
            told.extend(v.technicians.iter().filter_map(|t| t.2.clone()));
        }
        set_status(k, ctx, tx, v.id, "Cancelled", Doc::new()).await?;
    }
    Ok(told)
}
