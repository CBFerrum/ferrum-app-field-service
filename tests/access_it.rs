//! Who reaches what (`FERRUM_FIELD_SERVICE_TEST_DATABASE_URL`, emptied first; each test its own workspace): an action
//! that changes its record asks for the right to change it (K0-6), the links code reads customers' records by are
//! declared (K0-2), and a report groups, filters and shows only what its caller may read (K0-7).

mod common;
use common::*;
use serde_json::{Value, json};

/// Reads requests and work orders, may make work orders and sales invoices, and changes neither.
async fn reader(shop: &Shop) -> ferrum_kernel::Ctx {
    shop.role(
        "Field Reader",
        json!([
            {"entity": "ServiceRequest", "read": true},
            {"entity": "ServiceWorkOrder", "read": true, "create": true, "read_groups": ["planning"], "write_groups": ["planning"]},
            {"entity": "SalesInvoice", "read": true, "create": true},
            {"entity": "Customer", "read": true}, {"entity": "Company", "read": true}, {"entity": "CustomerEquipment", "read": true},
        ]),
    )
    .await;
    shop.ws.user(&format!("reader@{}.test", shop.slug), &["Field Reader"]).await
}

#[test]
fn a_reader_cannot_convert_a_request_or_invoice_a_work_order() {
    run(async {
        let shop = Shop::open("k06").await;
        let viewer = reader(&shop).await;
        let request = uid(&shop.insert(&shop.dispatcher, "ServiceRequest", json!({"subject": "No heat", "customer": shop.acme.to_string()})).await);
        let orders = "select count(*) from e_service_work_order where tenant_id = $1 and $2::uuid is not null";
        let before = shop.count(orders, request).await;
        refused(shop.try_act(&viewer, "ServiceRequest", request, "make_work_order", json!({})).await, "forbidden", "");
        let r = shop.get("ServiceRequest", request).await;
        assert_eq!((r["status"].clone(), r["work_order"].clone(), shop.count(orders, request).await), (json!("Open"), Value::Null, before), "nothing made");

        let wo = shop.job(json!({})).await;
        shop.completed(wo, 9).await;
        refused(shop.try_act(&viewer, "ServiceWorkOrder", wo, "create_invoice", json!({})).await, "forbidden", "");
        let w = shop.get("ServiceWorkOrder", wo).await;
        let invoices = shop.count("select count(*) from e_sales_invoice where tenant_id = $1 and $2::uuid is not null", wo).await;
        assert_eq!((w["status"].clone(), w["sales_invoice"].clone(), invoices), (json!("Completed"), Value::Null, 0), "nothing invoiced");

        // The desk still does both.
        shop.act(&shop.dispatcher, "ServiceRequest", request, "make_work_order", json!({})).await;
        shop.act(&shop.manager, "ServiceWorkOrder", wo, "create_invoice", json!({})).await;
        assert_eq!(shop.get("ServiceWorkOrder", wo).await["status"], json!("Invoiced"));
    });
}
