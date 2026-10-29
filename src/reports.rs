//! Field service reports: work orders by status or technician, first-time fix rate, SLA
//! compliance, technician utilization, parts consumption and revenue per contract. Every query
//! carries the caller's record scopes, and costs show only to roles that may read them.

use crate::child_table;
use crate::dispatch::technicians;
use crate::logic::{self, Ts};
use crate::setup::Settings;
use async_trait::async_trait;
use chrono::{Duration, NaiveDate};
use ferrum_domain::reports::{Params, ReportCompany, ReportSource, col, param_def, period, read_tx};
use ferrum_domain::util::money;
use ferrum_kernel::{Access, Action, Ctx, Error, Kernel, Result, Tx, row_scope};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use std::collections::HashMap;
use uuid::Uuid;

pub struct FieldServiceReports;

/// Groupings: label → SQL over the work order `a`, its territory `tr` and (Technician) crew `c`.
const GROUPS: [(&str, &str); 6] = [
    ("Status", "a.status"),
    ("Technician", "coalesce(c.technician_name, 'Unassigned')"),
    ("Territory", "coalesce(tr.territory_name, 'No Territory')"),
    ("Work Type", "coalesce(a.work_type, '')"),
    ("Priority", "coalesce(a.priority, '')"),
    ("Customer", "coalesce(a.customer_name, 'Unknown')"),
];

fn group_param(default: &str) -> Value {
    json!({"name": "group_by", "label": "Group By", "type": "select", "options": GROUPS.map(|(l, _)| l), "default": default})
}

fn grouping(p: &Params<'_>, default: &str) -> Result<(&'static str, &'static str)> {
    let want = p.str("group_by").unwrap_or(default);
    GROUPS
        .iter()
        .copied()
        .find(|(label, _)| label.eq_ignore_ascii_case(want))
        .ok_or_else(|| Error::field("group_by", format!("use one of: {}", GROUPS.map(|(l, _)| l).join(", "))))
}

/// The report period as local dates and the instants that bound them in the workspace's zone.
fn span(ctx: &Ctx, p: &Params<'_>) -> Result<(NaiveDate, NaiveDate, Ts, Ts)> {
    let co = ReportCompany { id: Uuid::nil(), name: String::new(), currency: String::new(), fy_month: ctx.fy_start_month, precision: 2 };
    let (from, to) = period(p, &co)?;
    let tz = logic::zone(None, &ctx.schema.timezone);
    Ok((from, to, logic::local_instant(tz, from, 0), logic::local_instant(tz, to + Duration::days(1), 0)))
}

/// `select <columns> from` the caller's visible work orders with their territory (and crew).
fn work_orders(ctx: &Ctx, columns: &str, with_crew: bool) -> Result<QueryBuilder<Postgres>> {
    let ent = ctx.schema.entity("ServiceWorkOrder").ok_or_else(|| Error::NotFound("ServiceWorkOrder".into()))?;
    let scope = row_scope(ctx, ent, Action::Read)?;
    let crew = if with_crew {
        format!(" left join {} c on c.tenant_id = a.tenant_id and c.parent_id = a.id", child_table(ctx, "ServiceWorkOrder", "crew")?)
    } else {
        String::new()
    };
    let mut qb = QueryBuilder::new(format!(
        "select {columns} from e_service_work_order a left join e_service_territory tr on tr.tenant_id = a.tenant_id and tr.id = a.territory{crew} where a.tenant_id = "
    ));
    qb.push_bind(ctx.tenant);
    scope.push_sql(&mut qb, "a");
    Ok(qb)
}

fn within(qb: &mut QueryBuilder<Postgres>, column: &str, from: Ts, to: Ts) {
    qb.push(format!(" and {column} >= ")).push_bind(from).push(format!(" and {column} < ")).push_bind(to);
}

fn pct(part: i64, whole: i64) -> Value {
    if whole == 0 { Value::Null } else { money((Decimal::from(part) * Decimal::ONE_HUNDRED / Decimal::from(whole)).round_dp(2)) }
}

fn ratio(part: Decimal, whole: Decimal) -> Value {
    if whole.is_zero() { Value::Null } else { money((part * Decimal::ONE_HUNDRED / whole).round_dp(2)) }
}

/// Whether the caller may read a field (costs are in the `costing` group).
fn readable(ctx: &Ctx, entity: &str, field: &str) -> bool {
    ctx.schema.entity(entity).and_then(|e| e.field(field)).is_some_and(|f| ctx.perms.can_read_field(entity, f))
}

fn meta(from: NaiveDate, to: NaiveDate, group: &str) -> Value {
    json!({"from_date": from, "to_date": to, "group_by": group})
}

type SummaryRow = (String, i64, i64, i64, i64, i64, i64, i64, i64);

async fn summary(ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let (from, to, start, end) = span(ctx, p)?;
    let (label, expr) = grouping(p, "Status")?;
    let counts = "count(distinct a.id), count(distinct a.id) filter (where a.status = 'New'), \
                  count(distinct a.id) filter (where a.status in ('Scheduled', 'Dispatched')), count(distinct a.id) filter (where a.status in ('En Route', 'On Site')), \
                  count(distinct a.id) filter (where a.status = 'Completed'), count(distinct a.id) filter (where a.status = 'Invoiced'), \
                  count(distinct a.id) filter (where a.status = 'Cancelled'), count(distinct a.id) filter (where a.sla_status = 'Breached')";
    let mut qb = work_orders(ctx, &format!("{expr}, {counts}"), label == "Technician")?;
    within(&mut qb, "a.reported_at", start, end);
    qb.push(" group by 1 order by 2 desc, 1");
    let data: Vec<SummaryRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let mut all = work_orders(ctx, &format!("'All'::text, {counts}"), false)?;
    within(&mut all, "a.reported_at", start, end);
    let total: SummaryRow = all.build_query_as().fetch_one(&mut **tx).await?;
    let keys = ["work_orders", "new", "scheduled", "in_progress", "completed", "invoiced", "cancelled", "sla_breached"];
    let row = |(group, a, b, c, d, e, f, g, h): SummaryRow| {
        let mut r = json!({"group": group});
        for (k, v) in keys.iter().zip([a, b, c, d, e, f, g, h]) {
            r[*k] = json!(v);
        }
        r
    };
    let mut totals = row(total);
    totals.as_object_mut().map(|m| m.remove("group"));
    Ok(json!({
        "columns": [col("group", label, "data"), col("work_orders", "Work Orders", "int"), col("new", "New", "int"), col("scheduled", "Scheduled", "int"),
            col("in_progress", "En Route / On Site", "int"), col("completed", "Completed", "int"), col("invoiced", "Invoiced", "int"),
            col("cancelled", "Cancelled", "int"), col("sla_breached", "SLA Breached", "int")],
        "rows": data.into_iter().map(row).collect::<Vec<_>>(),
        "totals": totals,
        "meta": meta(from, to, label),
    }))
}

type FixRow = (String, i64, i64, i64, Option<Decimal>);

async fn first_time_fix(ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let (from, to, start, end) = span(ctx, p)?;
    let (label, expr) = grouping(p, "Technician")?;
    let counts =
        "count(distinct a.id), count(distinct a.id) filter (where a.first_time_fix), count(distinct a.id) filter (where a.visits > 1), round(avg(a.visits), 2)";
    let completed = |qb: &mut QueryBuilder<Postgres>| {
        qb.push(" and a.docstatus = 1");
        within(qb, "a.completed_at", start, end);
    };
    let mut qb = work_orders(ctx, &format!("{expr}, {counts}"), label == "Technician")?;
    completed(&mut qb);
    qb.push(" group by 1 order by 2 desc, 1");
    let data: Vec<FixRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let mut all = work_orders(ctx, &format!("'All'::text, {counts}"), false)?;
    completed(&mut all);
    let total: FixRow = all.build_query_as().fetch_one(&mut **tx).await?;
    let row = |(group, n, fixed, revisits, visits): FixRow| {
        json!({"group": group, "completed": n, "first_time_fixes": fixed, "revisits": revisits, "first_time_fix_rate": pct(fixed, n),
               "average_visits": visits.map_or(Value::Null, money)})
    };
    let mut totals = row(total);
    totals.as_object_mut().map(|m| m.remove("group"));
    Ok(json!({
        "columns": [col("group", label, "data"), col("completed", "Completed", "int"), col("first_time_fixes", "Fixed on the First Visit", "int"),
            col("revisits", "Needed a Revisit", "int"), col("first_time_fix_rate", "First-Time Fix %", "decimal"), col("average_visits", "Average Visits", "decimal")],
        "rows": data.into_iter().map(row).collect::<Vec<_>>(),
        "totals": totals,
        "meta": meta(from, to, label),
    }))
}

type SlaRow = (String, i64, i64, i64, i64, i64);

async fn sla_compliance(ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let (from, to, start, end) = span(ctx, p)?;
    let (label, expr) = grouping(p, "Priority")?;
    let counts = "count(distinct a.id), count(distinct a.id) filter (where a.arrived_at is not null and not a.response_breached), \
                  count(distinct a.id) filter (where a.response_breached), count(distinct a.id) filter (where a.completed_at is not null and not a.resolution_breached), \
                  count(distinct a.id) filter (where a.resolution_breached)";
    let measured = |qb: &mut QueryBuilder<Postgres>| {
        qb.push(" and a.sla_start is not null and a.docstatus <> 2 and a.status <> 'Cancelled'");
        within(qb, "a.reported_at", start, end);
    };
    let mut qb = work_orders(ctx, &format!("{expr}, {counts}"), label == "Technician")?;
    measured(&mut qb);
    qb.push(" group by 1 order by 1");
    let data: Vec<SlaRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let mut all = work_orders(ctx, &format!("'All'::text, {counts}"), false)?;
    measured(&mut all);
    let total: SlaRow = all.build_query_as().fetch_one(&mut **tx).await?;
    let row = |(group, n, rm, rb, zm, zb): SlaRow| {
        json!({"group": group, "work_orders": n,
            "response_met": rm, "response_breached": rb, "response_pending": n - rm - rb, "response_pct": pct(rm, rm + rb),
            "resolution_met": zm, "resolution_breached": zb, "resolution_pending": n - zm - zb, "resolution_pct": pct(zm, zm + zb)})
    };
    let mut totals = row(total);
    totals.as_object_mut().map(|m| m.remove("group"));
    Ok(json!({
        "columns": [col("group", label, "data"), col("work_orders", "Work Orders", "int"),
            col("response_met", "Response Met", "int"), col("response_breached", "Response Breached", "int"), col("response_pending", "Response Pending", "int"),
            col("response_pct", "Response Compliance %", "decimal"),
            col("resolution_met", "Resolution Met", "int"), col("resolution_breached", "Resolution Breached", "int"), col("resolution_pending", "Resolution Pending", "int"),
            col("resolution_pct", "Resolution Compliance %", "decimal")],
        "rows": data.into_iter().map(row).collect::<Vec<_>>(),
        "totals": totals,
        "meta": meta(from, to, label),
    }))
}

/// Available hours (working time in each technician's zone), scheduled hours (non-cancelled
/// appointments), worked hours (labour started in the period, whatever became of the job),
/// billable hours (on jobs not cancelled) and completed jobs.
async fn utilization(k: &Kernel, ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let (from, to, start, end) = span(ctx, p)?;
    let territory = p.uuid("territory")?;
    let settings = Settings::load(k, ctx, tx).await?;
    let mut techs = technicians(tx, ctx, &settings, territory).await?;
    if ctx.perms.access("ServiceAppointment", Action::Read) == Access::Own {
        let me = ctx.email.to_lowercase();
        techs.retain(|t| t.email.as_deref() == Some(me.as_str()));
    }
    let labour = child_table(ctx, "ServiceWorkOrder", "labour")?;
    let worked: HashMap<Uuid, (Decimal, Decimal)> = sqlx::query_as::<_, (Uuid, Option<Decimal>, Option<Decimal>)>(sqlx::AssertSqlSafe(format!(
        "select l.technician, sum(l.hours), sum(l.hours) filter (where l.billable and w.status <> 'Cancelled') from {labour} l \
         join e_service_work_order w on w.tenant_id = l.tenant_id and w.id = l.parent_id \
         where l.tenant_id = $1 and l.technician is not null and l.from_time >= $2 and l.from_time < $3 group by 1"
    )))
    .bind(ctx.tenant)
    .bind(start)
    .bind(end)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|(t, h, b)| (t, (h.unwrap_or_default(), b.unwrap_or_default())))
    .collect();
    let slots = child_table(ctx, "ServiceAppointment", "technicians")?;
    let scheduled: HashMap<Uuid, Decimal> = sqlx::query_as::<_, (Uuid, Option<Decimal>)>(sqlx::AssertSqlSafe(format!(
        "select t.technician, sum(extract(epoch from (least(a.scheduled_end, $3) - greatest(a.scheduled_start, $2))))::numeric / 3600 from {slots} t \
         join e_service_appointment a on a.tenant_id = t.tenant_id and a.id = t.parent_id \
         where t.tenant_id = $1 and t.technician is not null and a.status <> 'Cancelled' and a.scheduled_start < $3 and a.scheduled_end > $2 group by 1"
    )))
    .bind(ctx.tenant)
    .bind(start)
    .bind(end)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|(t, h)| (t, h.unwrap_or_default().round_dp(2)))
    .collect();
    let crew = child_table(ctx, "ServiceWorkOrder", "crew")?;
    let jobs: HashMap<Uuid, i64> = sqlx::query_as::<_, (Uuid, i64)>(sqlx::AssertSqlSafe(format!(
        "select c.technician, count(distinct w.id) from {crew} c join e_service_work_order w on w.tenant_id = c.tenant_id and w.id = c.parent_id \
         where c.tenant_id = $1 and c.technician is not null and w.docstatus = 1 and w.completed_at >= $2 and w.completed_at < $3 group by 1"
    )))
    .bind(ctx.tenant)
    .bind(start)
    .bind(end)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();
    let mut totals = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, 0i64);
    let rows: Vec<Value> = techs
        .iter()
        .map(|t| {
            let available = logic::available_hours(t.tz, &t.windows, from, to);
            let (hours, billable) = worked.get(&t.id).copied().unwrap_or_default();
            let booked = scheduled.get(&t.id).copied().unwrap_or_default();
            let done = jobs.get(&t.id).copied().unwrap_or(0);
            totals = (totals.0 + available.unwrap_or_default(), totals.1 + booked, totals.2 + hours, totals.3 + billable, totals.4 + done);
            json!({"technician": t.name, "available_hours": available.map_or(Value::Null, money), "scheduled_hours": money(booked),
                   "worked_hours": money(hours), "billable_hours": money(billable), "utilization_pct": available.map_or(Value::Null, |a| ratio(hours, a)),
                   "billable_pct": ratio(billable, hours), "jobs_completed": done})
        })
        .collect();
    Ok(json!({
        "columns": [col("technician", "Technician", "data"), col("available_hours", "Available Hours", "decimal"), col("scheduled_hours", "Scheduled Hours", "decimal"),
            col("worked_hours", "Worked Hours", "decimal"), col("billable_hours", "Billable Hours", "decimal"), col("utilization_pct", "Utilization %", "decimal"),
            col("billable_pct", "Billable %", "decimal"), col("jobs_completed", "Jobs Completed", "int")],
        "rows": rows,
        "totals": {"available_hours": money(totals.0), "scheduled_hours": money(totals.1), "worked_hours": money(totals.2), "billable_hours": money(totals.3),
                   "utilization_pct": ratio(totals.2, totals.0), "billable_pct": ratio(totals.3, totals.2), "jobs_completed": totals.4},
        "meta": {"from_date": from, "to_date": to, "unit": "hours; available hours follow each technician's working hours in their own time zone"},
    }))
}

type PartRow = (String, String, Decimal, Decimal, Decimal, i64);

async fn parts(ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let (from, to, start, end) = span(ctx, p)?;
    let part_rows = child_table(ctx, "ServiceWorkOrder", "parts")?;
    let ent = ctx.schema.entity("ServiceWorkOrder").ok_or_else(|| Error::NotFound("ServiceWorkOrder".into()))?;
    let scope = row_scope(ctx, ent, Action::Read)?;
    let mut qb = QueryBuilder::new(format!(
        "select i.item_code, coalesce(i.item_name, ''), sum(x.qty), coalesce(sum(x.cost), 0), coalesce(sum(x.qty) filter (where x.warranty or a.parts_covered), 0), \
         count(distinct a.id) from {part_rows} x join e_service_work_order a on a.tenant_id = x.tenant_id and a.id = x.parent_id \
         join e_item i on i.tenant_id = x.tenant_id and i.id = x.item where x.tenant_id = "
    ));
    qb.push_bind(ctx.tenant).push(" and a.docstatus = 1");
    scope.push_sql(&mut qb, "a");
    within(&mut qb, "a.completed_at", start, end);
    if let Some(c) = p.uuid("company")? {
        qb.push(" and a.company = ").push_bind(c);
    }
    if let Some(w) = p.uuid("warehouse")? {
        qb.push(" and x.warehouse = ").push_bind(w);
    }
    qb.push(" group by 1, 2 order by 4 desc, 1");
    let data: Vec<PartRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let costs = readable(ctx, "ServiceWorkOrderPart", "cost");
    let mut totals = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let rows: Vec<Value> = data
        .into_iter()
        .map(|(code, name, qty, cost, free, orders)| {
            totals = (totals.0 + qty, totals.1 + cost, totals.2 + free);
            json!({"item_code": code, "item_name": name, "qty": money(qty), "free_qty": money(free), "billable_qty": money(qty - free),
                   "cost": if costs { money(cost) } else { Value::Null }, "work_orders": orders})
        })
        .collect();
    Ok(json!({
        "columns": [col("item_code", "Item", "data"), col("item_name", "Item Name", "data"), col("qty", "Quantity Used", "decimal"),
            col("free_qty", "Under Warranty or Contract", "decimal"), col("billable_qty", "Billable", "decimal"), col("cost", "Cost", "currency"),
            col("work_orders", "Work Orders", "int")],
        "rows": rows,
        "totals": {"qty": money(totals.0), "free_qty": money(totals.2), "billable_qty": money(totals.0 - totals.2), "cost": if costs { money(totals.1) } else { Value::Null }},
        "meta": {"from_date": from, "to_date": to},
    }))
}

type ContractRow = (String, String, Option<String>, Option<NaiveDate>, Option<NaiveDate>, Decimal, i64, i64, Decimal, Decimal);

/// Per contract over its life: its value, the work orders it covered, what they were invoiced
/// (submitted invoices, before tax), what they cost (labour and parts) and the margin.
async fn contract_revenue(ctx: &Ctx, p: &Params<'_>, tx: &mut Tx) -> Result<Value> {
    let ent = ctx.schema.entity("ServiceContract").ok_or_else(|| Error::NotFound("ServiceContract".into()))?;
    let scope = row_scope(ctx, ent, Action::Read)?;
    let orders = "from e_service_work_order w where w.tenant_id = a.tenant_id and w.service_contract = a.id";
    let mut qb = QueryBuilder::new(format!(
        "select coalesce(a.number, ''), coalesce(a.customer_name, ''), a.status, a.start_date, a.end_date, coalesce(a.contract_value, 0), \
         (select count(*) {orders} and w.docstatus <> 2 and w.status <> 'Cancelled'), (select count(*) {orders} and w.docstatus = 1), \
         (select coalesce(sum(si.base_net_total), 0) from e_service_work_order w join e_sales_invoice si on si.tenant_id = w.tenant_id and si.id = w.sales_invoice \
          where w.tenant_id = a.tenant_id and w.service_contract = a.id and si.docstatus = 1), \
         (select coalesce(sum(coalesce(w.labour_cost, 0) + coalesce(w.parts_cost, 0)), 0) {orders} and w.docstatus = 1) \
         from e_service_contract a where a.tenant_id = "
    ));
    qb.push_bind(ctx.tenant).push(" and a.docstatus = 1");
    scope.push_sql(&mut qb, "a");
    if let Some(c) = p.uuid("customer")? {
        qb.push(" and a.customer = ").push_bind(c);
    }
    if let Some(c) = p.uuid("company")? {
        qb.push(" and a.company = ").push_bind(c);
    }
    qb.push(" order by a.start_date desc, a.number");
    let data: Vec<ContractRow> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let costs = readable(ctx, "ServiceWorkOrder", "parts_cost") && readable(ctx, "ServiceWorkOrder", "labour_cost");
    let hide = |v: Decimal| if costs { money(v) } else { Value::Null };
    let mut t = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, 0i64, 0i64);
    let rows: Vec<Value> = data
        .into_iter()
        .map(|(number, customer, status, start, end, value, orders, completed, invoiced, cost)| {
            t = (t.0 + value, t.1 + invoiced, t.2 + cost, t.3 + orders, t.4 + completed);
            json!({"contract": number, "customer_name": customer, "status": status, "start_date": start, "end_date": end,
                   "contract_value": money(value), "work_orders": orders, "completed": completed, "invoiced": money(invoiced),
                   "revenue": money(value + invoiced), "cost": hide(cost), "margin": hide(value + invoiced - cost)})
        })
        .collect();
    Ok(json!({
        "columns": [col("contract", "Contract", "data"), col("customer_name", "Customer", "data"), col("status", "Status", "data"),
            col("start_date", "Start", "date"), col("end_date", "End", "date"), col("contract_value", "Contract Value", "currency"),
            col("work_orders", "Work Orders", "int"), col("completed", "Completed", "int"), col("invoiced", "Invoiced Work", "currency"),
            col("revenue", "Revenue", "currency"), col("cost", "Labour and Parts Cost", "currency"), col("margin", "Margin", "currency")],
        "rows": rows,
        "totals": {"contract_value": money(t.0), "invoiced": money(t.1), "revenue": money(t.0 + t.1), "cost": hide(t.2), "margin": hide(t.0 + t.1 - t.2),
                   "work_orders": t.3, "completed": t.4},
        "meta": {"unit": "company currency; invoiced work counts submitted invoices before tax"},
    }))
}

#[async_trait]
impl ReportSource for FieldServiceReports {
    fn catalog(&self) -> Vec<Value> {
        let entry = |name: &str, label: &str, entity: &str, params: Vec<Value>| json!({"name": name, "label": label, "module": "field_service", "entity": entity, "params": params});
        let dates = || vec![param_def("from_date"), param_def("to_date")];
        let link = |name: &str, label: &str, to: &str| json!({"name": name, "label": label, "type": "link", "to": to});
        vec![
            entry("fs_work_order_summary", "Work Orders by Status", "ServiceWorkOrder", [dates(), vec![group_param("Status")]].concat()),
            entry("fs_first_time_fix", "First-Time Fix Rate", "ServiceWorkOrder", [dates(), vec![group_param("Technician")]].concat()),
            entry("fs_sla_compliance", "Field Service SLA Compliance", "ServiceWorkOrder", [dates(), vec![group_param("Priority")]].concat()),
            entry(
                "fs_technician_utilization",
                "Technician Utilization",
                "ServiceAppointment",
                [dates(), vec![link("territory", "Service Territory", "ServiceTerritory")]].concat(),
            ),
            entry("fs_parts_consumption", "Parts Consumption", "ServiceWorkOrder", [dates(), vec![param_def("company"), param_def("warehouse")]].concat()),
            entry("fs_contract_revenue", "Revenue per Contract", "ServiceContract", vec![param_def("company"), param_def("customer")]),
        ]
    }

    async fn run(&self, k: &Kernel, ctx: &Ctx, name: &str, params: &HashMap<String, String>) -> Result<Value> {
        let p = Params { raw: params };
        let mut tx = read_tx(k, ctx).await?;
        let out = match name {
            "fs_work_order_summary" => summary(ctx, &p, &mut tx).await,
            "fs_first_time_fix" => first_time_fix(ctx, &p, &mut tx).await,
            "fs_sla_compliance" => sla_compliance(ctx, &p, &mut tx).await,
            "fs_technician_utilization" => utilization(k, ctx, &p, &mut tx).await,
            "fs_parts_consumption" => parts(ctx, &p, &mut tx).await,
            "fs_contract_revenue" => contract_revenue(ctx, &p, &mut tx).await,
            _ => Err(Error::NotFound(format!("report {name}"))),
        };
        tx.rollback().await?;
        out
    }
}
