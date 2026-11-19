//! Every action says what done means (`FERRUM_FIELD_SERVICE_TEST_DATABASE_URL`, emptied first; each test its own
//! workspace): each of the twelve is a capability with its effect, result and completion, planning a job is in the
//! catalog with its parameters, a repeat under one key does it once, and a change without a key or the right is refused.

mod common;
use common::*;
use serde_json::{Value, json};

const IDS: [&str; 12] = [
    "field_service.service_request.make_work_order",
    "field_service.service_request.reject",
    "field_service.service_request.tracking_link",
    "field_service.service_work_order.suggest_technicians",
    "field_service.service_work_order.schedule",
    "field_service.service_work_order.dispatch",
    "field_service.service_work_order.start_travel",
    "field_service.service_work_order.arrive",
    "field_service.service_work_order.complete",
    "field_service.service_work_order.cancel_work_order",
    "field_service.service_work_order.create_invoice",
    "field_service.service_appointment.cancel_appointment",
];

fn effect(shop: &Shop, id: &str) -> (Value, Value) {
    let c = shop.k.capability(&shop.admin, id).unwrap_or_else(|e| panic!("{id}: {e:?}"));
    (serde_json::to_value(c.effect).unwrap(), serde_json::to_value(c.unknown_outcome).unwrap())
}

#[test]
fn every_action_says_what_done_means() {
    run(async {
        let shop = Shop::open("fs1a").await;
        for id in IDS {
            let c = shop.k.capability(&shop.admin, id).unwrap_or_else(|e| panic!("{id}: {e:?}"));
            assert!(!c.completion.ends_with("is done, committed with this receipt") && !c.completion.starts_with("What "), "{id}: {}", c.completion);
            assert!(c.output["type"] == json!("object") && c.output["properties"].is_object(), "{id}: {}", c.output);
        }
    });
}

#[test]
fn suggest_is_a_query_and_writes_nothing() {
    run(async {
        let shop = Shop::open("fs1b").await;
        assert_eq!(effect(&shop, "field_service.service_work_order.suggest_technicians").0, json!("query"));
        let wo = shop.job(json!({})).await;
        let version = shop.get("ServiceWorkOrder", wo).await["version"].clone();
        let r = shop
            .invoke(&shop.dispatcher, "field_service.service_work_order.suggest_technicians", json!({"id": wo, "params": {"start": iso(at(1, 10, 0))}}), None)
            .await
            .expect("ranked");
        assert_eq!(r.result["technicians"].as_array().map(Vec::len), Some(2), "{}", r.result);
        assert_eq!(shop.get("ServiceWorkOrder", wo).await["version"], version, "nothing changed");
    });
}

#[test]
fn mails_are_outside_effects() {
    run(async {
        let shop = Shop::open("fs1c").await;
        let manual = (json!("external_effect"), json!("manual"));
        for action in ["service_work_order.dispatch", "service_work_order.start_travel", "service_request.reject", "service_request.tracking_link"] {
            assert_eq!(effect(&shop, &format!("field_service.{action}")), manual, "{action}");
        }
        for action in [
            "service_request.make_work_order",
            "service_work_order.schedule",
            "service_work_order.arrive",
            "service_work_order.complete",
            "service_work_order.cancel_work_order",
            "service_work_order.create_invoice",
            "service_appointment.cancel_appointment",
        ] {
            assert_eq!(effect(&shop, &format!("field_service.{action}")).0, json!("transactional_action"), "{action}");
        }
    });
}

#[test]
fn the_held_time_is_declared() {
    run(async {
        let shop = Shop::open("fs1d").await;
        for action in ["start_travel", "arrive", "complete"] {
            let c = shop.k.capability(&shop.admin, &format!("field_service.service_work_order.{action}")).unwrap_or_else(|e| panic!("{action}: {e:?}"));
            assert!(c.input["properties"]["params"]["properties"]["at"].is_object(), "{action}: {}", c.input);
        }
        let c = shop.k.capability(&shop.admin, "field_service.service_work_order.schedule").expect("schedule is in the catalog");
        for p in ["start", "end", "duration_minutes", "technician", "technicians", "notes"] {
            assert!(c.input["properties"]["params"]["properties"][p].is_object(), "{p}: {}", c.input);
        }
    });
}

#[test]
fn schedule_takes_ids_as_text() {
    run(async {
        let shop = Shop::open("fs1e").await;
        let wo = shop.job(json!({})).await;
        let text = format!("{}, {}", shop.alice, shop.bob);
        let r = shop
            .invoke(
                &shop.dispatcher,
                "field_service.service_work_order.schedule",
                json!({"id": wo, "params": {"start": iso(at(1, 9, 0)), "technicians": text}}),
                Some("s1"),
            )
            .await
            .expect("booked");
        let appt = shop.get("ServiceAppointment", uid(&r.result["id"])).await;
        let booked: Vec<Value> = appt["technicians"].as_array().unwrap().iter().map(|t| t["technician"].clone()).collect();
        assert_eq!(booked, [json!(shop.alice.to_string()), json!(shop.bob.to_string())]);
        // The list the dispatch board sends still works.
        let other = shop.job(json!({})).await;
        shop.act(&shop.dispatcher, "ServiceWorkOrder", other, "schedule", json!({"start": iso(at(1, 11, 0)), "technicians": [shop.alice.to_string()]})).await;
        let bad = shop.try_act(&shop.dispatcher, "ServiceWorkOrder", other, "schedule", json!({"start": iso(at(1, 13, 0)), "technicians": "nobody"})).await;
        refused(bad, "invalid", "technicians");
    });
}

#[test]
fn arrive_repeats_under_one_key() {
    run(async {
        let shop = Shop::open("fs1f").await;
        let wo = shop.job(json!({})).await;
        shop.act(&shop.dispatcher, "ServiceWorkOrder", wo, "schedule", json!({"technician": shop.alice.to_string(), "start": iso(at(1, 9, 0))})).await;
        shop.act(&shop.dispatcher, "ServiceWorkOrder", wo, "dispatch", json!({})).await;
        let arrive = || shop.invoke(&shop.alice_u, "field_service.service_work_order.arrive", json!({"id": wo, "params": {}}), Some("a1"));
        let first = arrive().await.expect("arrived");
        let arrived = shop.get("ServiceWorkOrder", wo).await["arrived_at"].clone();
        let second = arrive().await.expect("the same answer");
        assert!(!first.repeated && second.repeated && first.result == second.result);
        assert_eq!(shop.get("ServiceWorkOrder", wo).await["arrived_at"], arrived, "arrived once");
    });
}

#[test]
fn a_change_without_a_key_is_refused() {
    run(async {
        let shop = Shop::open("fs1g").await;
        let wo = shop.job(json!({})).await;
        let booked =
            shop.act(&shop.dispatcher, "ServiceWorkOrder", wo, "schedule", json!({"technician": shop.alice.to_string(), "start": iso(at(1, 9, 0))})).await;
        let r = shop.invoke(&shop.dispatcher, "field_service.service_work_order.dispatch", json!({"id": wo, "params": {}}), None).await;
        assert!(r.is_err(), "{r:?}");
        assert_eq!(shop.get("ServiceAppointment", uid(&booked["id"])).await["status"], json!("Scheduled"));
    });
}

#[test]
fn someone_without_the_right_is_refused() {
    run(async {
        let shop = Shop::open("fs1h").await;
        let wo = shop.job(json!({})).await;
        let booked =
            shop.act(&shop.dispatcher, "ServiceWorkOrder", wo, "schedule", json!({"technician": shop.alice.to_string(), "start": iso(at(1, 9, 0))})).await;
        let r = shop.invoke(&shop.bob_u, "field_service.service_work_order.dispatch", json!({"id": wo, "params": {}}), Some("d1")).await;
        assert!(r.is_err(), "{r:?}");
        let mine = shop.invoke(&shop.alice_u, "field_service.service_work_order.dispatch", json!({"id": wo, "params": {}}), Some("d2")).await;
        assert!(mine.is_err(), "a technician does not dispatch even their own: {mine:?}");
        assert_eq!(shop.get("ServiceAppointment", uid(&booked["id"])).await["status"], json!("Scheduled"));
    });
}
