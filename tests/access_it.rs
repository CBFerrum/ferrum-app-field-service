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

#[test]
fn a_customer_on_the_public_side_reaches_only_their_own_equipment() {
    run(async {
        let shop = Shop::open("k02").await;
        // A merge that moves these links is an administrator's: Field Service's code reads both by their customer.
        for entity in ["CustomerEquipment", "ServiceRequest"] {
            let links = &shop.admin.schema.entity(entity).unwrap().def.reach_links;
            assert!(links.iter().any(|l| l == "customer"), "{entity} declares its customer link: {links:?}");
        }
        let other = uid(&shop
            .insert(
                &shop.admin,
                "Item",
                json!({"item_code": "PUMP", "item_name": "pump", "is_stock_item": false,
            "item_group": shop.get("Item", shop.boiler).await["item_group"], "stock_uom": shop.get("Item", shop.boiler).await["stock_uom"]}),
            )
            .await);
        let acme_unit = uid(&shop
            .insert(&shop.dispatcher, "CustomerEquipment", json!({"customer": shop.acme.to_string(), "item": shop.boiler.to_string(), "serial_no": "X-1"}))
            .await);
        let beta_unit = uid(&shop
            .insert(&shop.dispatcher, "CustomerEquipment", json!({"customer": shop.beta.to_string(), "item": other.to_string(), "serial_no": "X-1"}))
            .await);
        shop.update(&shop.manager, "FieldServiceSettings", shop.settings, json!({"public_requests": true})).await;
        let file = |email: String| {
            let shop = shop.clone();
            async move {
                let req = ferrum_kernel::SiteRequest {
                    tenant: shop.ws.tenant,
                    user: None,
                    method: "POST".into(),
                    path: "/requests".into(),
                    query: Default::default(),
                    headers: Default::default(),
                    body: json!({"subject": "Noise", "contact_name": "Pat", "contact_email": email, "serial_no": "X-1"}).to_string().into_bytes(),
                    client_ip: "203.0.113.9".into(),
                };
                let r = shop.k.hooks.site("field_service").unwrap().clone().handle(&shop.k, req).await.expect("filed");
                let number = serde_json::from_slice::<Value>(&r.body).unwrap()["reference"].as_str().unwrap().to_string();
                shop.list(&shop.admin, "ServiceRequest", json!({"number": number})).await.remove(0)
            }
        };
        let from_beta = file(format!("desk@beta-{}.test", shop.slug)).await;
        assert_eq!((from_beta["customer"].clone(), from_beta["equipment"].clone()), (json!(shop.beta.to_string()), json!(beta_unit.to_string())));
        let from_acme = file(format!("ops@acme-{}.test", shop.slug)).await;
        assert_eq!((from_acme["customer"].clone(), from_acme["equipment"].clone()), (json!(shop.acme.to_string()), json!(acme_unit.to_string())));
        let stranger = file("someone@else.test".into()).await;
        assert_eq!((stranger["customer"].clone(), stranger["equipment"].clone()), (Value::Null, Value::Null), "an unknown address reaches no one's unit");
    });
}
