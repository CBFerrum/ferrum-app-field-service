//! Field Service: service requests, work orders, technician scheduling and dispatch, parts and
//! time, checklists, signatures and invoicing.
//!
//! * Setup: `FieldServiceSettings`, `ServiceTerritory`, `ServiceSkill`, `Technician`,
//!   `ServiceChecklistTemplate` and the installed base, `CustomerEquipment`.
//! * `ServiceRequest` (staff, helpdesk, public endpoint) becomes a `ServiceWorkOrder`. A work
//!   order's status follows its `ServiceAppointment`s (scheduled, dispatched, en route, on site);
//!   completing it is submitting it: required checklist items and the customer's signature are
//!   checked, its parts leave stock on a Material Issue, and it is frozen. It is invoiced once.
//! * Appointments reserve technicians' time; an exclusion constraint makes double booking
//!   impossible even under concurrent requests.
//! * `ServiceContract`s set response and resolution times and coverage, and maintenance creates
//!   their planned work orders exactly once per visit.
//! * The `field_service` site serves the dispatch board and the customers' request and tracking
//!   endpoints; see `packages/field_service/README.md`.

mod appointment;
mod contract;
mod dispatch;
mod invoice;
mod logic;
mod notify;
mod reports;
mod request;
mod setup;
mod site;
mod work_order;

use chrono::{DateTime, SecondsFormat, Utc};
use ferrum_domain::reports::ReportSource;
use ferrum_domain::util::{get, s, sys};
use ferrum_kernel::{Ctx, Doc, Error, Filter, HookCtx, HookRegistry, Kernel, Result, Tx, store};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

/// Registers this app's document hooks and its site. The Sales Invoice hook does nothing for
/// tenants without the package.
pub fn register(hooks: &mut HookRegistry) {
    hooks
        .register("FieldServiceSettings", Arc::new(setup::SettingsHook))
        .register("Technician", Arc::new(setup::TechnicianHook))
        .register("CustomerEquipment", Arc::new(setup::EquipmentHook))
        .register("ServiceRequest", Arc::new(request::RequestHook))
        .register("ServiceWorkOrder", Arc::new(work_order::WorkOrderHook))
        .register("ServiceAppointment", Arc::new(appointment::AppointmentHook))
        .register("ServiceContract", Arc::new(contract::ContractHook))
        .register("SalesInvoice", Arc::new(invoice::InvoiceLinkHook));
    hooks.add_site(PACKAGE, Arc::new(site::FieldServiceSite));
}

/// This app's reports.
pub fn reports() -> Vec<Arc<dyn ReportSource>> {
    vec![Arc::new(reports::FieldServiceReports)]
}

/// Periodic upkeep: every minute, on one replica at a time (advisory lock); must be idempotent and cheap.
/// Creates the work orders of due contract visits (once per visit), expires ended contracts and
/// refreshes the SLA verdicts of open work orders. A failing tenant is logged and does not stop
/// the others; the first error is returned.
pub async fn maintenance(k: &Kernel) -> Result<()> {
    let mut tx = k.db.system_tx().await?;
    let tenants: Vec<Uuid> = sqlx::query_scalar("select id from tenant where status = 'active' order by id").fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut first_error = None;
    for tenant in tenants {
        let res = async {
            let schema = k.registry.schema(tenant).await?;
            if !schema.packages.iter().any(|p| p == PACKAGE) {
                return Ok(());
            }
            let ctx = Ctx::system(tenant, schema);
            let generated = contract::generate_due(k, &ctx).await?;
            let expired = contract::expire(k, &ctx).await?;
            let refreshed = work_order::refresh_slas(k, &ctx).await?;
            if generated + expired + refreshed > 0 {
                tracing::info!(%tenant, generated, expired, refreshed, "field service maintenance");
            }
            Ok::<_, Error>(())
        }
        .await;
        if let Err(e) = res {
            tracing::warn!(%tenant, "field service maintenance failed: {e}");
            first_error.get_or_insert(e);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) const PACKAGE: &str = "field_service";

/// Whether the tenant behind `ctx` installed this package (hooks on shared entities check it).
pub(crate) fn installed(ctx: &Ctx) -> bool {
    ctx.schema.packages.iter().any(|p| p == PACKAGE)
}

/// Dispatchers and service managers plan and dispatch; technicians work what they are given.
pub(crate) fn is_dispatcher(ctx: &Ctx) -> bool {
    ctx.is_system || ctx.is_admin || ctx.has_role("Dispatcher") || ctx.has_role("Service Manager")
}

pub(crate) fn require_dispatcher(ctx: &Ctx, what: &str) -> Result<()> {
    if is_dispatcher(ctx) { Ok(()) } else { Err(Error::Forbidden(format!("only dispatchers and service managers can {what}"))) }
}

/// A whole-number field (missing or empty reads as 0).
pub(crate) fn int(doc: &Doc, key: &str) -> i64 {
    doc.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub(crate) fn ts(doc: &Doc, key: &str) -> Option<DateTime<Utc>> {
    s(doc, key).and_then(|v| ferrum_kernel::value::parse_datetime(v).ok())
}

/// A date-time in the kernel's canonical form (RFC 3339 UTC, milliseconds).
pub(crate) fn ts_value(t: DateTime<Utc>) -> Value {
    json!(t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub(crate) fn opt_ts(t: Option<DateTime<Utc>>) -> Value {
    t.map_or(Value::Null, ts_value)
}

/// Quoted physical table of a child table field (`e_parent__field`, shortened when long).
pub(crate) fn child_table(ctx: &Ctx, entity: &str, field: &str) -> Result<String> {
    ctx.schema
        .entity(entity)
        .and_then(|e| e.children.get(field))
        .map(|c| ferrum_kernel::ddl::q(&c.table))
        .ok_or_else(|| Error::internal(format!("{entity}.{field} is not a table")))
}

/// A linked record, or `None` when it does not exist (link validation reports that to the user).
pub(crate) async fn linked(k: &Kernel, ctx: &Ctx, tx: &mut Tx, entity: &str, id: Uuid) -> Result<Option<Doc>> {
    match get(k, ctx, tx, entity, id).await {
        Ok(d) => Ok(Some(d)),
        Err(Error::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// The stored version of the document being saved (`None` while it is being created).
pub(crate) async fn stored(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<Option<Doc>> {
    match ferrum_domain::util::id(doc, "id") {
        Some(i) => store::load(hc.tx, &hc.ctx.schema, hc.entity, hc.ctx.tenant, i, false).await,
        None => Ok(None),
    }
}

/// The technician record of the signed-in user, if any.
pub(crate) async fn my_technician(k: &Kernel, ctx: &Ctx, tx: &mut Tx) -> Result<Option<Doc>> {
    if ctx.email.is_empty() || ctx.is_system {
        return Ok(None);
    }
    let found = k.find_tx(&sys(ctx), tx, "Technician", &[Filter::eq("user_email", ctx.email.to_lowercase())], None, 1).await?;
    Ok(found.into_iter().next())
}

include!(concat!(env!("OUT_DIR"), "/packages.rs"));

/// This app's manifest (`app.yaml`).
pub const MANIFEST: &str = include_str!("../app.yaml");

/// This app's metadata packages, embedded at build time.
pub fn packages() -> std::result::Result<Vec<ferrum_meta::Package>, ferrum_meta::MetaError> {
    ferrum_meta::catalog::load_embedded(EMBEDDED)
}

#[cfg(test)]
mod tests {
    #[test]
    fn packages_validate_with_the_platform() {
        let mut all = ferrum_domain::packages().expect("platform packages");
        all.extend(ferrum_app_erp::packages().expect("ERP's packages"));
        let ours = super::packages().expect("app packages parse");
        assert_eq!(ours.iter().map(|p| p.name()).collect::<Vec<_>>(), ["field_service"]);
        assert_eq!(ours[0].sql.len(), 1, "the exclusion constraint ships with the package");
        all.extend(ours);
        ferrum_meta::Catalog::from_packages(all).expect("the app's metadata validates with the platform's");
        assert!(super::MANIFEST.contains("id: field-service") && super::MANIFEST.contains("packages: [field_service]"));
    }
}
