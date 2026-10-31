//! Invoicing a completed work order: one draft Sales Invoice priced by the selling engine — parts
//! at price-list rates (pricing rules apply), labour hours × the technician's bill rate, billable
//! expenses at cost — with warranty and contract coverage as a 100% discount, so the customer sees
//! what was free. A work order is invoiced once; deleting or cancelling its invoice releases it.

use crate::setup::Settings;
use crate::work_order::label;
use crate::{installed, ts};
use async_trait::async_trait;
use ferrum_domain::flow::created;
use ferrum_domain::util::{b, company, d, elevated, get, id, money, rows, s, sys};
use ferrum_kernel::{Action, Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result, Tx};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use uuid::Uuid;

/// The invoice lines of a work order, or why it cannot be invoiced (nothing billable, an item
/// missing in the settings). Reads only.
pub async fn lines(k: &Kernel, ctx: &Ctx, tx: &mut Tx, wo: &Doc, settings: &Settings) -> Result<Vec<Value>> {
    let tz = crate::logic::zone(None, &ctx.schema.timezone);
    let cover = if b(wo, "under_warranty") {
        "under warranty".to_string()
    } else {
        match id(wo, "service_contract") {
            Some(c) => format!("covered by contract {}", s(&get(k, ctx, tx, "ServiceContract", c).await?, "number").unwrap_or_default()),
            None => String::new(),
        }
    };
    let mut out = Vec::new();
    for r in rows(wo, "parts") {
        let free = b(&r, "warranty") || b(wo, "parts_covered");
        let mut desc = s(&r, "item_name").unwrap_or_default().to_string();
        let serials = ferrum_app_erp::stock::parse_serials(s(&r, "serial_no"));
        if !serials.is_empty() {
            desc.push_str(&format!(" (serial {})", serials.join(", ")));
        }
        if free {
            desc.push_str(if b(&r, "warranty") { " — replaced under warranty" } else { " — " });
            if !b(&r, "warranty") {
                desc.push_str(&cover);
            }
        }
        let mut line = json!({"item": r.get("item"), "qty": r.get("qty"), "description": desc, "serial_no": r.get("serial_no"), "batch_no": r.get("batch_no")});
        if free {
            line["discount_percent"] = json!("100");
        }
        out.push(line);
    }
    let free_labour = b(wo, "labour_covered");
    for r in rows(wo, "labour").iter().filter(|r| b(r, "billable") && d(r, "hours") > Decimal::ZERO) {
        let item = settings.labour_item.ok_or_else(|| Error::invalid("set the labour item in Field Service Settings to invoice labour"))?;
        let (from, to) = (ts(r, "from_time"), ts(r, "to_time"));
        let when = match (from, to) {
            (Some(a), Some(z)) => {
                format!(", {} {}–{}", a.with_timezone(&tz).format("%Y-%m-%d"), a.with_timezone(&tz).format("%H:%M"), z.with_timezone(&tz).format("%H:%M"))
            }
            _ => String::new(),
        };
        let mut desc = format!("Labour: {}{when} ({} h)", s(r, "technician_name").unwrap_or_default(), d(r, "hours").normalize());
        if free_labour {
            desc.push_str(&format!(" — {cover}"));
        }
        let mut line = json!({"item": item.to_string(), "qty": money(d(r, "hours")), "description": desc,
                              "discount_percent": if free_labour { "100" } else { "0" }});
        // Without a bill rate the labour item's own price applies.
        if d(r, "bill_rate") > Decimal::ZERO {
            line["price_list_rate"] = money(d(r, "bill_rate"));
        }
        out.push(line);
    }
    for r in rows(wo, "expenses").iter().filter(|r| b(r, "billable")) {
        let item = settings.expense_item.ok_or_else(|| Error::invalid("set the expense item in Field Service Settings to invoice expenses"))?;
        let desc = match s(r, "description") {
            Some(text) => format!("{}: {text}", s(r, "expense_type").unwrap_or("Expense")),
            None => s(r, "expense_type").unwrap_or("Expense").to_string(),
        };
        out.push(json!({"item": item.to_string(), "qty": "1", "price_list_rate": money(d(r, "amount")), "discount_percent": "0", "description": desc}));
    }
    if out.is_empty() {
        return Err(Error::invalid("nothing to invoice: the work order has no parts, billable labour or billable expenses"));
    }
    Ok(out)
}

/// Creates the draft invoice with engine rights (line prices are engine-set fields) and links the
/// work order to it.
pub async fn insert(hc: &mut HookCtx<'_>, wo: &Doc, lines: Vec<Value>) -> Result<Doc> {
    let wo_id = id(wo, "id").ok_or_else(|| Error::internal("work order without id"))?;
    let co = company(hc.kernel, hc.ctx, hc.tx, id(wo, "company").ok_or_else(|| Error::field("company", "is required"))?).await?;
    let mut input = Doc::new();
    input.insert("company".into(), json!(co.id.to_string()));
    input.insert("customer".into(), wo.get("customer").cloned().unwrap_or(Value::Null));
    // Bill rates and expenses are kept in the company currency.
    input.insert("currency".into(), json!(co.currency_id.to_string()));
    input.insert("items".into(), Value::Array(lines));
    let mut remarks = format!("Service work order {}", label(wo));
    if let Some(serial) = s(wo, "serial_no") {
        remarks.push_str(&format!(", serial {serial}"));
    }
    input.insert("remarks".into(), json!(remarks));
    let inv = hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "SalesInvoice", input).await?;
    let mut v = Doc::new();
    v.insert("sales_invoice".into(), inv.get("id").cloned().unwrap_or(Value::Null));
    v.insert("status".into(), json!("Invoiced"));
    hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceWorkOrder", wo_id, v).await?;
    Ok(inv)
}

/// `create_invoice`: the user must be allowed to create sales invoices. The work order's row is
/// locked by the action, so two requests at once make one invoice.
pub async fn create(hc: &mut HookCtx<'_>, wo: &Doc) -> Result<Value> {
    hc.ctx.require("SalesInvoice", Action::Create)?;
    if let Some(inv) = id(wo, "sales_invoice") {
        let number = get(hc.kernel, hc.ctx, hc.tx, "SalesInvoice", inv).await.ok().and_then(|i| s(&i, "number").map(str::to_string));
        return Err(Error::invalid(format!("this work order is already invoiced{}", number.map(|n| format!(" on {n}")).unwrap_or_default())));
    }
    if s(wo, "status") != Some("Completed") {
        return Err(Error::invalid("only completed work orders are invoiced"));
    }
    let settings = Settings::load(hc.kernel, hc.ctx, hc.tx).await?;
    let lines = lines(hc.kernel, hc.ctx, hc.tx, wo, &settings).await?;
    let inv = insert(hc, wo, lines).await?;
    Ok(created("SalesInvoice", &inv))
}

/// Releases the work order of a Sales Invoice that is deleted (a draft) or cancelled, so it can
/// be invoiced again.
pub struct InvoiceLinkHook;

async fn release(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
    if !installed(hc.ctx) {
        return Ok(());
    }
    let Some(inv) = id(doc, "id") else { return Ok(()) };
    let orders: Vec<Uuid> = sqlx::query_scalar("select id from e_service_work_order where tenant_id = $1 and sales_invoice = $2 for update")
        .bind(hc.ctx.tenant)
        .bind(inv)
        .fetch_all(&mut **hc.tx)
        .await?;
    for wo in orders {
        let mut v = Doc::new();
        v.insert("sales_invoice".into(), Value::Null);
        v.insert("status".into(), json!("Completed"));
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ServiceWorkOrder", wo, v).await?;
    }
    Ok(())
}

#[async_trait]
impl DocHook for InvoiceLinkHook {
    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        release(hc, doc).await
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        release(hc, doc).await
    }
}
