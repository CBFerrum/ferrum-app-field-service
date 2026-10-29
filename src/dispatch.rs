//! Dispatch: an explainable ranking of technicians for a work order (skills, territory,
//! availability, travel), and the dispatch board — each technician's days (working hours in
//! their own time zone, appointments, travel between them) and the unscheduled work orders by
//! priority and SLA.

use crate::appointment::{param_ts, window};
use crate::logic::{self, Facts, Ts, Window};
use crate::setup::{self, Settings, point};
use crate::{child_table, opt_ts, require_dispatcher, ts, ts_value};
use chrono::{Duration, DurationRound, NaiveDate, Utc};
use chrono_tz::Tz;
use ferrum_domain::util::{id, money, rows, s};
use ferrum_kernel::ctx::RowScope;
use ferrum_kernel::{Access, Action, Ctx, Doc, Error, HookCtx, Kernel, Result, Tx, row_scope};
use rust_decimal::Decimal;
use serde_json::{Map, Value, json};
use sqlx::QueryBuilder;
use std::collections::HashMap;
use uuid::Uuid;

/// An active technician as dispatch sees them.
pub(crate) struct Tech {
    pub id: Uuid,
    pub name: String,
    pub email: Option<String>,
    pub territory: Option<Uuid>,
    pub skills: Vec<Uuid>,
    pub tz: Tz,
    pub windows: Vec<Window>,
    pub home: Option<(Decimal, Decimal)>,
}

/// Active technicians (of one territory) with their skills and working hours (the settings'
/// default hours when they have none).
pub(crate) async fn technicians(tx: &mut Tx, ctx: &Ctx, settings: &Settings, territory: Option<Uuid>) -> Result<Vec<Tech>> {
    let heads: Vec<(Uuid, String, Option<String>, Option<Uuid>, Option<String>, Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
        "select id, technician_name, user_email, territory, time_zone, home_latitude, home_longitude from e_technician \
         where tenant_id = $1 and active and ($2::uuid is null or territory = $2) order by technician_name, id",
    )
    .bind(ctx.tenant)
    .bind(territory)
    .fetch_all(&mut **tx)
    .await?;
    let skills: Vec<(Uuid, Uuid)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select parent_id, skill from {} where tenant_id = $1 and skill is not null",
        child_table(ctx, "Technician", "skills")?
    )))
    .bind(ctx.tenant)
    .fetch_all(&mut **tx)
    .await?;
    let hours: Vec<(Uuid, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select parent_id, weekday, start_time, end_time from {} where tenant_id = $1 order by parent_id, idx",
        child_table(ctx, "Technician", "working_hours")?
    )))
    .bind(ctx.tenant)
    .fetch_all(&mut **tx)
    .await?;
    Ok(heads
        .into_iter()
        .map(|(tid, name, email, territory, zone, lat, lng)| {
            let own: Vec<Window> = hours.iter().filter(|h| h.0 == tid).filter_map(|h| setup::window(h.1.as_deref(), h.2.as_deref(), h.3.as_deref())).collect();
            Tech {
                id: tid,
                name,
                email: email.map(|e| e.to_lowercase()),
                territory,
                skills: skills.iter().filter(|x| x.0 == tid).map(|x| x.1).collect(),
                tz: logic::zone(zone.as_deref(), &ctx.schema.timezone),
                windows: if own.is_empty() { settings.default_hours.clone() } else { own },
                home: lat.zip(lng),
            }
        })
        .collect())
}

/// One technician's place on an appointment.
struct Booking {
    technician: Uuid,
    appointment: Uuid,
    number: String,
    status: String,
    start: Ts,
    end: Ts,
    actual_start: Option<Ts>,
    actual_end: Option<Ts>,
    work_order: Uuid,
    wo_number: String,
    customer: String,
    priority: Option<String>,
    site: Option<(Decimal, Decimal)>,
    busy: bool,
}

type BookingRow = (Uuid, Uuid, String, String, Ts, Ts, Option<Ts>, Option<Ts>, Uuid, String, String, Option<String>, Option<Decimal>, Option<Decimal>, bool);

/// Technicians' non-cancelled appointments overlapping `[from, to)`, within `scope` when given.
async fn bookings(tx: &mut Tx, ctx: &Ctx, from: Ts, to: Ts, exclude_wo: Option<Uuid>, scope: Option<&RowScope>) -> Result<Vec<Booking>> {
    let child = child_table(ctx, "ServiceAppointment", "technicians")?;
    let mut qb = QueryBuilder::new(format!(
        "select t.technician, a.id, coalesce(a.number, a.id::text), a.status, a.scheduled_start, a.scheduled_end, a.actual_start, a.actual_end, \
         w.id, coalesce(w.number, ''), coalesce(w.customer_name, ''), w.priority, w.latitude, w.longitude, t.busy \
         from {child} t join e_service_appointment a on a.tenant_id = t.tenant_id and a.id = t.parent_id \
         join e_service_work_order w on w.tenant_id = a.tenant_id and w.id = a.work_order where t.tenant_id = "
    ));
    qb.push_bind(ctx.tenant);
    qb.push(" and t.technician is not null and a.status <> 'Cancelled' and tstzrange(a.scheduled_start, a.scheduled_end, '[)') && tstzrange(");
    qb.push_bind(from).push(", ").push_bind(to).push(", '[)')");
    if let Some(wo) = exclude_wo {
        qb.push(" and a.work_order <> ").push_bind(wo);
    }
    if let Some(sc) = scope {
        sc.push_sql(&mut qb, "a");
    }
    qb.push(" order by t.technician, a.scheduled_start, a.id");
    let found: Vec<BookingRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
    Ok(found
        .into_iter()
        .map(|(technician, appointment, number, status, start, end, actual_start, actual_end, work_order, wo_number, customer, priority, lat, lng, busy)| {
            Booking {
                technician,
                appointment,
                number,
                status,
                start,
                end,
                actual_start,
                actual_end,
                work_order,
                wo_number,
                customer,
                priority,
                site: lat.zip(lng),
                busy,
            }
        })
        .collect())
}

async fn territory_names(tx: &mut Tx, ctx: &Ctx) -> Result<HashMap<Uuid, String>> {
    Ok(sqlx::query_as::<_, (Uuid, String)>("select id, territory_name from e_service_territory where tenant_id = $1")
        .bind(ctx.tenant)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .collect())
}

fn hours(seconds: i64) -> Value {
    money((Decimal::from(seconds) / Decimal::from(3600)).round_dp(2))
}

/// `suggest_technicians {start?, end? | duration_minutes?}`: every active technician ranked for
/// the slot (default: the current appointment's, else the preferred time, else the next quarter
/// hour), eligible ones first, each with its score and reasons.
pub async fn suggest(hc: &mut HookCtx<'_>, wo: &Doc, params: &Value) -> Result<Value> {
    require_dispatcher(hc.ctx, "rank technicians")?;
    let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
    let scheduled = ts(wo, "scheduled_start").filter(|_| matches!(s(wo, "status"), Some("Scheduled" | "Dispatched")));
    let start = match param_ts(params, "start")? {
        Some(t) => t,
        None => scheduled.or_else(|| ts(wo, "preferred_start")).unwrap_or_else(|| {
            let now = Utc::now();
            now.duration_trunc(Duration::minutes(15)).unwrap_or(now) + Duration::minutes(15)
        }),
    };
    let end = match param_ts(params, "end")? {
        Some(e) => e,
        None => {
            let minutes = params
                .get("duration_minutes")
                .and_then(Value::as_i64)
                .or_else(|| Some(crate::int(wo, "estimated_duration_minutes")).filter(|m| *m > 0))
                .unwrap_or(settings.default_duration);
            start + Duration::minutes(minutes.clamp(1, 31 * 1440))
        }
    };
    if end <= start {
        return Err(Error::field("end", "must be after the start"));
    }
    let ranked = rank(hc.ctx, hc.tx, wo, start, end, &settings).await?;
    Ok(json!({"work_order": wo.get("id"), "start": ts_value(start), "end": ts_value(end), "technicians": ranked}))
}

async fn rank(ctx: &Ctx, tx: &mut Tx, wo: &Doc, start: Ts, end: Ts, settings: &Settings) -> Result<Vec<Value>> {
    let required: Vec<Uuid> = rows(wo, "required_skills").iter().filter_map(|r| id(r, "skill")).collect();
    let skill_names: HashMap<Uuid, String> =
        sqlx::query_as::<_, (Uuid, String)>("select id, skill_name from e_service_skill where tenant_id = $1 and id = any($2)")
            .bind(ctx.tenant)
            .bind(&required)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .collect();
    let territories = territory_names(tx, ctx).await?;
    let techs = technicians(tx, ctx, settings, None).await?;
    let around = bookings(tx, ctx, start - Duration::days(2), end + Duration::days(2), id(wo, "id"), None).await?;
    let (site, territory) = (point(wo, "latitude", "longitude"), id(wo, "territory"));
    let mut ranked: Vec<(logic::Assessment, i64, String, Value)> = Vec::new();
    for t in &techs {
        let mine: Vec<&Booking> = around.iter().filter(|b| b.technician == t.id).collect();
        let busy_with = mine.iter().find(|b| b.busy && b.start < end && b.end > start).map(|b| format!("{} {}", b.number, window(ctx, b.start, b.end)));
        let day = start.with_timezone(&t.tz).date_naive();
        let (day_start, day_end) = (logic::local_instant(t.tz, day, 0), logic::local_instant(t.tz, day + Duration::days(1), 0));
        let jobs = mine.iter().filter(|b| b.busy && b.start < day_end && b.end > day_start).count() as i64;
        // The day starts at home; after a job, the technician leaves from that job's site.
        let previous = mine.iter().filter(|b| b.end <= start && b.end > day_start && b.site.is_some()).max_by_key(|b| b.end);
        let origin = previous.and_then(|p| p.site.map(|x| (x, p.number.clone()))).or_else(|| t.home.map(|h| (h, "home".to_string())));
        let travel = match (origin, site) {
            (Some((from, label)), Some(to)) => {
                let (km, minutes) = logic::travel(from, to, settings.speed_kmh);
                Some((km, minutes, label))
            }
            _ => None,
        };
        let late = match (previous, &travel) {
            (Some(p), Some((_, minutes, _))) => (p.end + Duration::minutes(*minutes) - start).num_minutes().max(0),
            _ => 0,
        };
        let facts = Facts {
            missing_skills: required.iter().filter(|r| !t.skills.contains(r)).map(|r| skill_names.get(r).cloned().unwrap_or_else(|| r.to_string())).collect(),
            busy_with,
            same_territory: territory.map(|w| t.territory == Some(w)),
            territory_name: t.territory.and_then(|x| territories.get(&x).cloned()),
            within_hours: logic::within_hours(t.tz, &t.windows, start, end),
            travel: travel.clone(),
            late_minutes: late,
            jobs_that_day: jobs,
        };
        let a = logic::assess(&facts);
        let row = json!({
            "technician": t.id, "technician_name": t.name, "eligible": a.eligible, "score": a.score,
            "distance_km": travel.as_ref().map(|x| money(x.0)), "travel_minutes": travel.as_ref().map(|x| x.1),
            "travel_from": travel.as_ref().map(|x| x.2.clone()), "territory": t.territory, "territory_name": facts.territory_name,
            "within_working_hours": facts.within_hours, "jobs_that_day": jobs, "reasons": a.reasons,
        });
        ranked.push((a, travel.map_or(i64::MAX, |x| x.1), t.name.clone(), row));
    }
    ranked.sort_by(|x, y| y.0.eligible.cmp(&x.0.eligible).then(y.0.score.cmp(&x.0.score)).then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));
    Ok(ranked.into_iter().map(|x| x.3).collect())
}

type OpenRow = (
    Uuid,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<Ts>,
    Option<Ts>,
    Option<Ts>,
    Option<String>,
    bool,
    Option<Uuid>,
    Option<Decimal>,
    Option<Decimal>,
    Option<i64>,
    Option<Ts>,
);

/// `GET /dispatch?from=&to=&territory=`: the board over local dates (at most 31 days). What the
/// caller may read decides what is shown: technicians who see their own appointments only see
/// their own day.
pub async fn board(k: &Kernel, ctx: &Ctx, query: &Map<String, Value>) -> Result<Value> {
    ctx.require("ServiceAppointment", Action::Read)?;
    ctx.require("ServiceWorkOrder", Action::Read)?;
    let q = |key: &str| query.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let day = |key: &str| q(key).map(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").map_err(|_| Error::field(key, "use the format YYYY-MM-DD"))).transpose();
    let from = day("from")?.unwrap_or_else(|| ctx.today());
    let to = day("to")?.unwrap_or(from);
    if to < from {
        return Err(Error::field("to", "must not be before from"));
    }
    if (to - from).num_days() > 30 {
        return Err(Error::field("to", "the board shows at most 31 days"));
    }
    let territory = q("territory").map(|v| v.parse::<Uuid>().map_err(|_| Error::field("territory", "is not a territory id"))).transpose()?;
    let tz = logic::zone(None, &ctx.schema.timezone);
    let (start, end) = (logic::local_instant(tz, from, 0), logic::local_instant(tz, to + Duration::days(1), 0));
    let mut tx = k.db.tenant_tx_with_timeout(ctx.tenant, k.db.config.report_timeout_ms).await?;
    let settings = Settings::load(k, ctx, &mut tx).await?;
    let territories = territory_names(&mut tx, ctx).await?;
    let mut techs = technicians(&mut tx, ctx, &settings, territory).await?;
    if ctx.perms.access("ServiceAppointment", Action::Read) == Access::Own {
        let me = ctx.email.to_lowercase();
        techs.retain(|t| t.email.as_deref() == Some(me.as_str()));
    }
    let appointments = k.entity(ctx, "ServiceAppointment")?;
    let scope = row_scope(ctx, &appointments, Action::Read)?;
    let booked = bookings(&mut tx, ctx, start, end, None, Some(&scope)).await?;
    let clip = |a: Ts, z: Ts| (z.min(end) - a.max(start)).num_seconds().max(0);
    let mut people = Vec::new();
    for t in &techs {
        let mine: Vec<&Booking> = booked.iter().filter(|b| b.technician == t.id).collect();
        let working = logic::working_intervals(t.tz, &t.windows, start, end);
        let mut visits = Vec::new();
        let mut last: Option<(NaiveDate, (Decimal, Decimal), String)> = None;
        for b in &mine {
            let local = b.start.with_timezone(&t.tz).date_naive();
            let origin = match &last {
                Some((d, site, number)) if *d == local => Some((*site, number.clone())),
                _ => t.home.map(|h| (h, "home".to_string())),
            };
            let travel = match (origin, b.site) {
                (Some((from, label)), Some(to)) => {
                    let (km, minutes) = logic::travel(from, to, settings.speed_kmh);
                    json!({"from": label, "km": money(km), "minutes": minutes})
                }
                _ => Value::Null,
            };
            visits.push(json!({
                "appointment": b.appointment, "number": b.number, "status": b.status, "start": ts_value(b.start), "end": ts_value(b.end),
                "actual_start": opt_ts(b.actual_start), "actual_end": opt_ts(b.actual_end), "work_order": b.work_order, "work_order_number": b.wo_number,
                "customer_name": b.customer, "priority": b.priority, "site": b.site.map(|(la, lo)| json!({"latitude": money(la), "longitude": money(lo)})),
                "travel": travel,
            }));
            if let Some(site) = b.site {
                last = Some((local, site, b.number.clone()));
            }
        }
        people.push(json!({
            "technician": t.id, "technician_name": t.name, "user_email": t.email, "territory": t.territory,
            "territory_name": t.territory.and_then(|x| territories.get(&x).cloned()), "time_zone": t.tz.name(),
            "home": t.home.map(|(la, lo)| json!({"latitude": money(la), "longitude": money(lo)})),
            "working_hours": working.iter().map(|(a, z)| json!({"start": ts_value((*a).max(start)), "end": ts_value((*z).min(end))})).collect::<Vec<_>>(),
            "available_hours": if t.windows.is_empty() { Value::Null } else { hours(working.iter().map(|(a, z)| clip(*a, *z)).sum()) },
            "booked_hours": hours(mine.iter().filter(|b| b.busy).map(|b| clip(b.start, b.end)).sum()),
            "appointments": visits,
        }));
    }

    let orders = k.entity(ctx, "ServiceWorkOrder")?;
    let wscope = row_scope(ctx, &orders, Action::Read)?;
    let mut qb = QueryBuilder::new(
        "select a.id, coalesce(a.number, ''), coalesce(a.customer_name, ''), a.priority, a.work_type, a.reported_at, a.response_due, a.resolution_due, \
         a.sla_status, a.response_breached, a.territory, a.latitude, a.longitude, a.estimated_duration_minutes, a.preferred_start \
         from e_service_work_order a where a.tenant_id = ",
    );
    qb.push_bind(ctx.tenant).push(" and a.docstatus = 0 and a.status = 'New'");
    if let Some(t) = territory {
        qb.push(" and a.territory = ").push_bind(t);
    }
    wscope.push_sql(&mut qb, "a");
    qb.push(" order by case a.priority when 'Urgent' then 0 when 'High' then 1 when 'Medium' then 2 else 3 end, a.response_due asc nulls last, a.reported_at, a.id limit 500");
    let open: Vec<OpenRow> = qb.build_query_as().fetch_all(&mut *tx).await?;
    let ids: Vec<Uuid> = open.iter().map(|o| o.0).collect();
    let skills: Vec<(Uuid, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select r.parent_id, k.skill_name from {} r join e_service_skill k on k.tenant_id = r.tenant_id and k.id = r.skill \
         where r.tenant_id = $1 and r.parent_id = any($2) order by r.parent_id, r.idx",
        child_table(ctx, "ServiceWorkOrder", "required_skills")?
    )))
    .bind(ctx.tenant)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    tx.rollback().await?;
    let unscheduled: Vec<Value> = open
        .into_iter()
        .map(|(wid, number, customer, priority, work_type, reported, response_due, resolution_due, sla, breached, terr, lat, lng, minutes, preferred)| {
            json!({
                "work_order": wid, "number": number, "customer_name": customer, "priority": priority, "work_type": work_type,
                "reported_at": opt_ts(reported), "response_due": opt_ts(response_due), "resolution_due": opt_ts(resolution_due),
                "sla_status": sla, "response_breached": breached, "territory": terr, "territory_name": terr.and_then(|x| territories.get(&x).cloned()),
                "site": lat.zip(lng).map(|(la, lo)| json!({"latitude": money(la), "longitude": money(lo)})),
                "estimated_duration_minutes": minutes, "preferred_start": opt_ts(preferred),
                "required_skills": skills.iter().filter(|x| x.0 == wid).map(|x| x.1.clone()).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({
        "from": from.to_string(), "to": to.to_string(), "time_zone": tz.name(), "travel_speed_kmh": money(settings.speed_kmh),
        "technicians": people, "unscheduled": unscheduled,
    }))
}
