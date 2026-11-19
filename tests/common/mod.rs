//! What Field Service's suites on the platform's test kit share (docs/testkit.md): one kernel per test binary, booted
//! as the server boots one on `FERRUM_FIELD_SERVICE_TEST_DATABASE_URL` (emptied first), each test in its own workspace;
//! a small firm (a company, two customers, a dispatcher, a service manager and two technicians) and the steps of a job.
#![allow(dead_code)]

use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use ferrum_kernel::capability::{Invocation, Receipt};
use ferrum_kernel::{Ctx, Doc, Kernel, ListQuery, Result};
#[allow(unused_imports)]
pub use ferrum_testkit::{Kit, Workspace, app, database, dec, obj, refused, run, uid};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub const ZONE: &str = "Europe/London";

static KIT: tokio::sync::OnceCell<Kit> = tokio::sync::OnceCell::const_new();

/// The binary's kernel, booted by the first test that asks.
pub async fn kit() -> &'static Kit {
    KIT.get_or_init(|| async {
        let apps = [app!("erp", ferrum_app_erp), app!("field-service", ferrum_app_field_service)];
        Kit::boot(&database("FERRUM_FIELD_SERVICE_TEST_DATABASE_URL"), &apps).await
    })
    .await
}

pub fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn tz() -> chrono_tz::Tz {
    ZONE.parse().unwrap()
}

pub fn today() -> NaiveDate {
    Utc::now().with_timezone(&tz()).date_naive()
}

/// `days` after today in London at `h:m` local time.
pub fn at(days: i64, h: u32, m: u32) -> DateTime<Utc> {
    tz().from_local_datetime(&(today() + Duration::days(days)).and_hms_opt(h, m, 0).unwrap()).earliest().unwrap().with_timezone(&Utc)
}

/// A firm on its own workspace: `admin`, a service `manager`, a `dispatcher`, technicians Alice (`alice`, signed in as
/// `alice_u`) and Bob, customers Acme (with an email) and Beta, a labour and an expense item in the settings, and
/// service levels per priority. Checklists and signatures are not required, so a job completes from on site.
#[derive(Clone)]
pub struct Shop {
    pub ws: Workspace,
    pub k: Arc<Kernel>,
    pub slug: String,
    pub admin: Ctx,
    pub manager: Ctx,
    pub dispatcher: Ctx,
    pub alice_u: Ctx,
    pub bob_u: Ctx,
    pub alice: Uuid,
    pub bob: Uuid,
    pub company: Uuid,
    pub acme: Uuid,
    pub beta: Uuid,
    pub settings: Uuid,
    pub north: Uuid,
    pub gas: Uuid,
    pub boiler: Uuid,
    pub labour_item: Uuid,
    pub expense_item: Uuid,
}

impl Shop {
    pub async fn open(slug: &str) -> Shop {
        let kit = kit().await;
        let ws = kit.workspace(slug, &["field_service"], json!({"fiscal_year_start_month": 4, "timezone": ZONE})).await;
        let k = ws.k.clone();
        let admin = ws.admin.clone();
        let find = |entity: &'static str, filters: Value| {
            let (k, admin) = (k.clone(), admin.clone());
            async move {
                let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), limit: Some(5), ..Default::default() };
                let rows = k.list(&admin, entity, &q).await.unwrap_or_else(|e| panic!("list {entity}: {e:?}")).rows;
                assert_eq!(rows.len(), 1, "{entity} {filters}");
                uid(&rows[0])
            }
        };
        let gbp = find("Currency", json!({"code": "GBP"})).await;
        let ins = |entity: &'static str, v: Value| {
            let (k, admin) = (k.clone(), admin.clone());
            async move { uid(&k.insert(&admin, entity, obj(v)).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))) }
        };
        let company = ins("Company", json!({"company_name": format!("{slug} Services"), "abbr": "FS", "default_currency": gbp.to_string()})).await;
        let services = find("ItemGroup", json!({"group_name": "Services"})).await;
        let products = find("ItemGroup", json!({"group_name": "Products"})).await;
        let hour = find("Uom", json!({"uom_name": "Hour"})).await;
        let nos = find("Uom", json!({"uom_name": "Nos"})).await;
        let item = |code: &'static str, group: Uuid, uom: Uuid| {
            ins(
                "Item",
                json!({"item_code": code, "item_name": code.to_lowercase(), "item_group": group.to_string(), "stock_uom": uom.to_string(), "is_stock_item": false}),
            )
        };
        let labour_item = item("LABOUR", services, hour).await;
        let expense_item = item("EXPENSES", services, nos).await;
        let boiler = item("BOILER", products, nos).await;
        let settings = ins(
            "FieldServiceSettings",
            json!({"labour_item": labour_item.to_string(), "expense_item": expense_item.to_string(), "require_checklist": false, "require_signature": false,
                   "sla_targets": [{"priority": "Urgent", "response_hours": "2", "resolution_hours": "8"}, {"priority": "High", "response_hours": "4", "resolution_hours": "24"},
                                   {"priority": "Medium", "response_hours": "8", "resolution_hours": "48"}, {"priority": "Low", "response_hours": "24", "resolution_hours": "72"}]}),
        )
        .await;
        let north = ins("ServiceTerritory", json!({"territory_name": "North"})).await;
        let gas = ins("ServiceSkill", json!({"skill_name": "Gas"})).await;
        let manager = ws.user(&format!("manager@{slug}.test"), &["Service Manager"]).await;
        let dispatcher = ws.user(&format!("dispatch@{slug}.test"), &["Dispatcher"]).await;
        let alice_u = ws.user(&format!("alice@{slug}.test"), &["Technician"]).await;
        let bob_u = ws.user(&format!("bob@{slug}.test"), &["Technician"]).await;
        let tech = |name: &'static str, email: String, home: (&'static str, &'static str)| {
            ins(
                "Technician",
                json!({"technician_name": name, "user_email": email, "territory": north.to_string(), "bill_rate": "80", "hourly_cost": "30",
                       "home_latitude": home.0, "home_longitude": home.1, "skills": [{"skill": gas.to_string()}]}),
            )
        };
        let alice = tech("Alice Smith", format!("alice@{slug}.test"), ("51.50", "-0.12")).await;
        let bob = tech("Bob Jones", format!("bob@{slug}.test"), ("51.80", "-0.12")).await;
        let acme = ins("Customer", json!({"customer_name": "Acme Flats", "email": format!("ops@acme-{slug}.test")})).await;
        let beta = ins("Customer", json!({"customer_name": "Beta Offices", "email": format!("desk@beta-{slug}.test")})).await;
        Shop {
            ws: ws.clone(),
            k,
            slug: slug.to_string(),
            admin,
            manager,
            dispatcher,
            alice_u,
            bob_u,
            alice,
            bob,
            company,
            acme,
            beta,
            settings,
            north,
            gas,
            boiler,
            labour_item,
            expense_item,
        }
    }

    pub async fn try_insert(&self, ctx: &Ctx, entity: &str, v: Value) -> Result<Doc> {
        self.k.insert(ctx, entity, obj(v)).await
    }
    pub async fn insert(&self, ctx: &Ctx, entity: &str, v: Value) -> Doc {
        self.try_insert(ctx, entity, v).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))
    }
    pub async fn try_get(&self, ctx: &Ctx, entity: &str, id: Uuid) -> Result<Doc> {
        self.k.get(ctx, entity, id, false).await
    }
    pub async fn get(&self, entity: &str, id: Uuid) -> Doc {
        self.try_get(&self.admin, entity, id).await.unwrap_or_else(|e| panic!("get {entity}: {e:?}"))
    }
    pub async fn try_update(&self, ctx: &Ctx, entity: &str, id: Uuid, v: Value) -> Result<Doc> {
        self.k.update(ctx, entity, id, obj(v), None).await
    }
    pub async fn update(&self, ctx: &Ctx, entity: &str, id: Uuid, v: Value) -> Doc {
        self.try_update(ctx, entity, id, v).await.unwrap_or_else(|e| panic!("update {entity}: {e:?}"))
    }
    pub async fn try_act(&self, ctx: &Ctx, entity: &str, id: Uuid, name: &str, params: Value) -> Result<Value> {
        self.k.run_action(ctx, entity, id, name, params).await
    }
    pub async fn act(&self, ctx: &Ctx, entity: &str, id: Uuid, name: &str, params: Value) -> Value {
        self.try_act(ctx, entity, id, name, params).await.unwrap_or_else(|e| panic!("{entity}.{name}: {e:?}"))
    }
    /// A capability through the gate, under `key` when given.
    pub async fn invoke(&self, ctx: &Ctx, capability: &str, input: Value, key: Option<&str>) -> Result<Receipt> {
        let inv = Invocation::new(capability, input);
        self.k
            .invoke(
                ctx,
                match key {
                    Some(key) => inv.key(key),
                    None => inv,
                },
            )
            .await
    }
    pub async fn list(&self, ctx: &Ctx, entity: &str, filters: Value) -> Vec<Doc> {
        let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), limit: Some(500), ..Default::default() };
        self.k.list(ctx, entity, &q).await.unwrap_or_else(|e| panic!("list {entity}: {e:?}")).rows
    }
    /// One number from SQL with the workspace as `$1` and `id` as `$2`.
    pub async fn count(&self, sql: &str, id: Uuid) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.ws.tenant).await.unwrap();
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(self.ws.tenant).bind(id).fetch_one(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        n
    }
    /// A statement with the workspace as `$1` and `id` as `$2`.
    pub async fn exec(&self, sql: &str, id: Uuid) {
        let mut tx = self.k.db.tenant_tx(self.ws.tenant).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).bind(self.ws.tenant).bind(id).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    pub async fn report(&self, ctx: &Ctx, name: &str, params: &[(&str, &str)]) -> Result<Value> {
        let p = params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ferrum_domain::reports::run(&self.k, ctx, name, &p).await
    }
    /// A role made here: one rule per entry (`PermissionDef` as JSON).
    pub async fn role(&self, name: &str, rules: Value) {
        for r in rules.as_array().unwrap() {
            let p: ferrum_meta::PermissionDef = serde_json::from_value(r.clone()).unwrap();
            self.k.set_role_permission(&self.admin, name, &p).await.unwrap_or_else(|e| panic!("role {name}: {e:?}"));
        }
    }

    /// A new work order for Acme, made by the dispatcher, with `extra` fields.
    pub async fn job(&self, extra: Value) -> Uuid {
        let mut v = json!({"company": self.company.to_string(), "customer": self.acme.to_string(), "priority": "Medium", "description": "No heat"});
        for (key, x) in extra.as_object().cloned().unwrap_or_default() {
            v[key] = x;
        }
        uid(&self.insert(&self.dispatcher, "ServiceWorkOrder", v).await)
    }

    /// Alice scheduled on `wo` tomorrow at `hour` for an hour, dispatched, and on site. The appointment's id.
    pub async fn on_site(&self, wo: Uuid, hour: u32) -> Uuid {
        let booked = self
            .act(
                &self.dispatcher,
                "ServiceWorkOrder",
                wo,
                "schedule",
                json!({"technician": self.alice.to_string(), "start": iso(at(1, hour, 0)), "duration_minutes": 60}),
            )
            .await;
        self.act(&self.dispatcher, "ServiceWorkOrder", wo, "dispatch", json!({})).await;
        self.act(&self.alice_u, "ServiceWorkOrder", wo, "arrive", json!({})).await;
        uid(&booked["id"])
    }

    /// `wo` worked by Alice (on site from `hour` tomorrow) with a billable parking expense, and completed.
    pub async fn completed(&self, wo: Uuid, hour: u32) {
        self.on_site(wo, hour).await;
        self.update(&self.alice_u, "ServiceWorkOrder", wo, json!({"expenses": [{"expense_type": "Parking", "amount": "12.50"}]})).await;
        self.act(&self.alice_u, "ServiceWorkOrder", wo, "complete", json!({})).await;
    }
}
