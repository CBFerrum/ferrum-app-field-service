//! Service contracts and their maintenance plans. Submitting a contract activates it; maintenance
//! then creates a work order for every planned visit when it comes within the lead time — exactly
//! once per visit: the contract row is locked while a visit is planned and its next due date
//! moves in the same transaction, and a unique index on (contract, due date) backs it up.

use crate::logic;
use crate::{int, linked};
use async_trait::async_trait;
use chrono::{Duration, NaiveDate};
use ferrum_domain::util::{date, id, s, set, sys};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result, with_retry};
use serde_json::{Value, json};
use uuid::Uuid;

/// Visits planned per contract and run at most (a long-stopped server catches up in steps).
const CATCH_UP: usize = 50;

pub struct ContractHook;

fn status_on(doc: &Doc, today: NaiveDate) -> &'static str {
    match date(doc, "end_date") {
        Ok(end) if end < today => "Expired",
        _ => "Active",
    }
}

#[async_trait]
impl DocHook for ContractHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if int(doc, "docstatus") == 0 {
            set(doc, "status", "Draft");
            if s(doc, "first_due_date").is_none() {
                set(doc, "first_due_date", doc.get("start_date").cloned().unwrap_or(Value::Null));
            }
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if let Some(e) = id(doc, "equipment")
            && let Some(eq) = linked(hc.kernel, hc.ctx, hc.tx, "CustomerEquipment", e).await?
            && id(&eq, "customer") != id(doc, "customer")
        {
            return Err(Error::field("equipment", "belongs to another customer"));
        }
        Ok(())
    }

    async fn on_submit(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let contract = id(doc, "id").ok_or_else(|| Error::internal("contract without id"))?;
        let mut v = Doc::new();
        v.insert("status".into(), json!(status_on(doc, hc.ctx.today())));
        v.insert("next_due_date".into(), doc.get("first_due_date").or(doc.get("start_date")).cloned().unwrap_or(Value::Null));
        v.insert("occurrences".into(), json!(0));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceContract", contract, v).await
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let contract = id(doc, "id").ok_or_else(|| Error::internal("contract without id"))?;
        let mut v = Doc::new();
        v.insert("status".into(), json!("Cancelled"));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceContract", contract, v).await
    }
}

/// Maintenance: plans the due visits of every active contract. A contract that fails is logged
/// and retried next time; the others go on.
pub async fn generate_due(k: &Kernel, ctx: &Ctx) -> Result<usize> {
    let today = ctx.today();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_service_contract where tenant_id = $1 and docstatus = 1 and status = 'Active' and next_due_date is not null \
         and next_due_date - coalesce(lead_days, 0)::int <= $2 order by next_due_date, id limit 500",
    )
    .bind(ctx.tenant)
    .bind(today)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut planned = 0;
    for contract in due {
        match with_retry(|| plan(k, ctx, contract, today)).await {
            Ok(n) => planned += n,
            Err(e) => tracing::warn!(tenant = %ctx.tenant, %contract, "planning contract visits failed: {e}"),
        }
    }
    Ok(planned)
}

/// Creates the work orders of one contract's due visits under its row lock.
async fn plan(k: &Kernel, ctx: &Ctx, contract: Uuid, today: NaiveDate) -> Result<usize> {
    let sctx = sys(ctx);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(&sctx, &mut tx, "ServiceContract", contract, true).await?;
    if int(&doc, "docstatus") != 1 || s(&doc, "status") != Some("Active") {
        tx.commit().await?;
        return Ok(0);
    }
    let first = date(&doc, "first_due_date").or_else(|_| date(&doc, "start_date"))?;
    let end = date(&doc, "end_date")?;
    let lead = Duration::days(int(&doc, "lead_days").clamp(0, 365));
    let (frequency, every) = (s(&doc, "frequency").unwrap_or("Months").to_string(), int(&doc, "repeat_every").clamp(1, 1000) as u32);
    let mut k_next = int(&doc, "occurrences").max(0) as u32;
    let mut due = date(&doc, "next_due_date").ok();
    let mut made = 0;
    while let Some(day) = due {
        if day > end || day - lead > today || made >= CATCH_UP {
            break;
        }
        let mut wo = Doc::new();
        for f in ["company", "customer", "equipment", "work_type", "priority", "checklist_template", "estimated_duration_minutes"] {
            if let Some(v) = doc.get(f).filter(|v| !v.is_null()) {
                wo.insert(f.into(), v.clone());
            }
        }
        wo.insert("description".into(), json!(format!("Planned visit due {day} under service contract {}", s(&doc, "number").unwrap_or_default())));
        wo.insert("service_contract".into(), json!(contract.to_string()));
        wo.insert("contract_due_date".into(), json!(day.to_string()));
        k.insert_tx(&sctx, &mut tx, "ServiceWorkOrder", wo).await?;
        made += 1;
        k_next += 1;
        due = logic::visit_date(first, &frequency, every, k_next);
    }
    // After the last visit of the term nothing is due any more; the contract still covers work
    // orders until it ends.
    let mut v = Doc::new();
    v.insert("occurrences".into(), json!(k_next));
    v.insert("next_due_date".into(), json!(due.filter(|d| *d <= end).map(|d| d.to_string())));
    k.set_values_tx(&sctx, &mut tx, "ServiceContract", contract, v).await?;
    tx.commit().await?;
    Ok(made)
}

/// Maintenance: contracts whose term has ended are expired (their work orders stay).
pub async fn expire(k: &Kernel, ctx: &Ctx) -> Result<usize> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let n = sqlx::query(
        "update e_service_contract set status = 'Expired', updated_at = now() where tenant_id = $1 and docstatus = 1 and status = 'Active' and end_date < $2",
    )
    .bind(ctx.tenant)
    .bind(ctx.today())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(n as usize)
}
