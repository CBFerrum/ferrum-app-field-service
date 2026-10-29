//! End-to-end field service test against a real PostgreSQL (`FERRUM_FIELD_SERVICE_TEST_DATABASE_URL`,
//! default `postgres://ferrum:ferrum@localhost:5432/ferrum_field_service_test`). The database is reset first.
//!
//! A heating engineer firm in London runs its field service: a phoned-in request becomes a work
//! order, the best technician is suggested and scheduled, dispatched, travels, arrives, ticks the
//! checklist, uses parts from the van, logs time and expenses, gets the customer's signature and
//! completes — stock leaves the van on a Material Issue — and the job is invoiced exactly once.
//! Warranty work is free, concurrent bookings cannot double-book a technician, maintenance plans
//! create their visits once however often maintenance runs, SLAs are judged, customers file and
//! follow requests on the public endpoints, the dispatch board shows the days (DST included) and
//! the reports add it up within each user's permissions.

use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use ferrum_kernel::files::FileStore;
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, Result, SiteRequest, SiteResponse};
use ferrum_meta::Catalog;
use hmac::{Hmac, Mac};
use rust_decimal::Decimal;
use serde_json::{Map, Value, json};
use sha2::Sha256;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const PASSWORD: &str = "Correct-Horse-9";
const ZONE: &str = "Europe/London";

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(doc: &Doc) -> Uuid {
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn vid(v: &Value) -> Uuid {
    v.as_str().unwrap_or_else(|| panic!("not an id: {v}")).parse().unwrap()
}

fn dec(v: &Value) -> Decimal {
    match v {
        Value::String(s) => Decimal::from_str(s).unwrap_or_else(|_| panic!("not a decimal: {s}")),
        Value::Number(n) => Decimal::from_str(&n.to_string()).unwrap(),
        Value::Null => Decimal::ZERO,
        other => panic!("not a decimal: {other}"),
    }
}

fn n(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn tz() -> chrono_tz::Tz {
    ZONE.parse().unwrap()
}

/// Today in London, read once so the scenario's dates agree with each other.
fn today() -> NaiveDate {
    static DAY: std::sync::OnceLock<NaiveDate> = std::sync::OnceLock::new();
    *DAY.get_or_init(|| Utc::now().with_timezone(&tz()).date_naive())
}

/// `days` after today in London at `h:m` local time.
fn at(days: i64, h: u32, m: u32) -> DateTime<Utc> {
    tz().from_local_datetime(&(today() + Duration::days(days)).and_hms_opt(h, m, 0).unwrap()).earliest().unwrap().with_timezone(&Utc)
}

/// Whether a result is a validation error on `field`.
fn refused<T: std::fmt::Debug>(r: &Result<T>, field: &str) -> bool {
    matches!(r, Err(Error::Validation(e)) if e.iter().any(|f| f.field == field))
}

fn says<T: std::fmt::Debug>(r: &Result<T>, text: &str) -> bool {
    r.is_err() && format!("{r:?}").contains(text)
}

#[derive(Default)]
struct MemFiles(Mutex<HashMap<String, Vec<u8>>>);

#[async_trait]
impl FileStore for MemFiles {
    async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
        self.0.lock().unwrap().insert(key.into(), data.to_vec());
        Ok(())
    }
    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        self.0.lock().unwrap().get(key).cloned().ok_or_else(|| Error::NotFound("file".into()))
    }
    async fn delete(&self, key: &str) -> Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

#[derive(Clone)]
struct T {
    k: Arc<Kernel>,
    ctx: Ctx,
}

impl T {
    async fn try_insert(&self, entity: &str, v: Value) -> Result<Doc> {
        self.k.insert(&self.ctx, entity, obj(v)).await
    }
    async fn insert(&self, entity: &str, v: Value) -> Doc {
        self.try_insert(entity, v).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))
    }
    async fn try_update(&self, entity: &str, id: Uuid, v: Value) -> Result<Doc> {
        self.k.update(&self.ctx, entity, id, obj(v), None).await
    }
    async fn update(&self, entity: &str, id: Uuid, v: Value) -> Doc {
        self.try_update(entity, id, v).await.unwrap_or_else(|e| panic!("update {entity}: {e:?}"))
    }
    async fn try_get(&self, entity: &str, id: Uuid) -> Result<Doc> {
        self.k.get(&self.ctx, entity, id, false).await
    }
    async fn get(&self, entity: &str, id: Uuid) -> Doc {
        self.try_get(entity, id).await.unwrap_or_else(|e| panic!("get {entity}: {e:?}"))
    }
    async fn submit(&self, entity: &str, id: Uuid) -> Doc {
        self.k.submit(&self.ctx, entity, id, None).await.unwrap_or_else(|e| panic!("submit {entity}: {e:?}"))
    }
    async fn try_act(&self, entity: &str, id: Uuid, name: &str, params: Value) -> Result<Value> {
        self.k.run_action(&self.ctx, entity, id, name, params).await
    }
    async fn act(&self, entity: &str, id: Uuid, name: &str, params: Value) -> Value {
        self.try_act(entity, id, name, params).await.unwrap_or_else(|e| panic!("{entity}.{name}: {e:?}"))
    }
    async fn list(&self, entity: &str, filters: Value) -> Vec<Doc> {
        let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), limit: Some(500), ..Default::default() };
        self.k.list(&self.ctx, entity, &q).await.unwrap_or_else(|e| panic!("list {entity}: {e:?}")).rows
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let rows = self.list(entity, filters.clone()).await;
        assert_eq!(rows.len(), 1, "{entity} {filters}");
        rows[0].clone()
    }
    async fn report(&self, name: &str, params: &[(&str, String)]) -> Result<Value> {
        let p: HashMap<String, String> = params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        ferrum_domain::reports::run(&self.k, &self.ctx, name, &p).await
    }
    async fn user(&self, email: &str, roles: &[&str]) -> T {
        let roles: Vec<String> = roles.iter().map(|r| r.to_string()).collect();
        let id = self.k.create_user(&self.ctx, email, email, Some(PASSWORD), &roles, false).await.expect("user");
        T { k: self.k.clone(), ctx: self.k.load_ctx(self.ctx.tenant, id, None, "it".into()).await.expect("ctx") }
    }
    /// A signed-in call to the package's site.
    async fn site(&self, method: &str, path: &str, query: Value) -> Result<SiteResponse> {
        call(&self.k, self.ctx.tenant, Some(self.ctx.clone()), method, path, query, Vec::new(), "application/json").await
    }
    async fn board(&self, from: NaiveDate, to: NaiveDate) -> Value {
        let r = self.site("GET", "/dispatch", json!({"from": from.to_string(), "to": to.to_string()})).await.expect("dispatch board");
        serde_json::from_slice(&r.body).unwrap()
    }
    /// Uploads a file attached to a record, as `POST /api/files` does.
    async fn upload(&self, entity: &str, record: Uuid, name: &str, ctype: &str) -> String {
        let f = self.k.store_file(&self.ctx, Some((entity, record)), name, ctype, b"\x89PNG\r\n\x1a\nsignature").await.expect("upload");
        f["url"].as_str().unwrap().to_string()
    }
    async fn count(&self, sql: &str, id: Uuid) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.ctx.tenant).await.unwrap();
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(self.ctx.tenant).bind(id).fetch_one(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        n
    }
    async fn exec(&self, sql: &str, id: Uuid) {
        let mut tx = self.k.db.tenant_tx(self.ctx.tenant).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).bind(self.ctx.tenant).bind(id).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    async fn notifications(&self, user: Uuid) -> Vec<String> {
        let mut tx = self.k.db.tenant_tx(self.ctx.tenant).await.unwrap();
        sqlx::query_scalar("select title from notification where tenant_id = $1 and user_id = $2 order by id")
            .bind(self.ctx.tenant)
            .bind(user)
            .fetch_all(&mut *tx)
            .await
            .unwrap()
    }
    async fn stock(&self, item: Uuid, wh: Uuid) -> Decimal {
        let mut tx = self.k.db.tenant_tx(self.ctx.tenant).await.unwrap();
        sqlx::query_scalar::<_, Decimal>("select qty from stock_balance where tenant_id = $1 and item_id = $2 and warehouse_id = $3")
            .bind(self.ctx.tenant)
            .bind(item)
            .bind(wh)
            .fetch_optional(&mut *tx)
            .await
            .unwrap()
            .unwrap_or_default()
    }
    /// Debit minus credit on an account (by name) across all postings.
    async fn gl(&self, account: &str) -> Decimal {
        let mut tx = self.k.db.tenant_tx(self.ctx.tenant).await.unwrap();
        sqlx::query_scalar(
            "select coalesce(sum(l.debit - l.credit), 0) from journal_line l join e_account a on a.tenant_id = l.tenant_id and a.id = l.account_id \
             where l.tenant_id = $1 and a.account_name = $2",
        )
        .bind(self.ctx.tenant)
        .bind(account)
        .fetch_one(&mut *tx)
        .await
        .unwrap()
    }
}

#[allow(clippy::too_many_arguments)]
async fn call(k: &Kernel, tenant: Uuid, user: Option<Ctx>, method: &str, path: &str, query: Value, body: Vec<u8>, accept: &str) -> Result<SiteResponse> {
    let site = k.hooks.site("field_service").expect("the site is mounted").clone();
    let mut headers = Map::new();
    headers.insert("accept".into(), json!(accept));
    let req = SiteRequest {
        tenant,
        user,
        method: method.into(),
        path: path.into(),
        query: query.as_object().cloned().unwrap_or_default(),
        headers,
        body,
        client_ip: "203.0.113.7".into(),
    };
    site.handle(k, req).await
}

/// A public call (no user) to the site.
async fn public(k: &Kernel, tenant: Uuid, method: &str, path: &str, body: Value) -> Result<SiteResponse> {
    let bytes = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
    call(k, tenant, None, method, path, json!({}), bytes, "application/json").await
}

fn body(r: &SiteResponse) -> Value {
    serde_json::from_slice(&r.body).unwrap()
}

/// A tracking token signed with the tenant's key, as the app makes them (to test expiry).
async fn signed(t: &T, request: Uuid, expires: i64) -> String {
    let mut tx = t.k.db.tenant_tx(t.ctx.tenant).await.unwrap();
    let key: Vec<u8> = sqlx::query_scalar("select secret from field_service_secret where tenant_id = $1").bind(t.ctx.tenant).fetch_one(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
    mac.update(format!("ferrum-field-service-track:{request}:{expires}").as_bytes());
    format!("{}.{expires}.{}", request.simple(), hex::encode(&mac.finalize().into_bytes()[..16]))
}

#[test]
fn field_service_end_to_end() {
    // Same runtime shape as the server: unoptimized async hook chains need more than 2 MiB.
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let url =
        std::env::var("FERRUM_FIELD_SERVICE_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_field_service_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 16, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_field_service::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    ferrum_app_field_service::register(&mut hooks);
    for source in ferrum_app_field_service::reports() {
        ferrum_domain::reports::add_source(source);
    }
    let k = Kernel::boot(db, catalog, hooks, KernelSettings::default(), None).await.expect("boot");
    k.set_file_store(Arc::new(MemFiles::default()));
    ferrum_domain::maintenance(&k).await.expect("partitions");
    let tenant = k
        .create_tenant(NewTenant {
            slug: "heatco".into(),
            name: "HeatCo Services".into(),
            admin_email: "admin@heatco.test".into(),
            admin_password: PASSWORD.into(),
            admin_name: None,
            packages: vec!["field_service".into()],
            settings: Some(json!({"fiscal_year_start_month": 4, "timezone": ZONE})),
        })
        .await
        .expect("tenant");
    let session = k.login("heatco", "admin@heatco.test", PASSWORD).await.expect("login");
    let admin = T { k: k.clone(), ctx: k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx") };
    let a = &admin;

    // ───────────── the firm: company, tax, items, prices, vans with stock ─────────────
    let gbp = a.find_one("Currency", json!({"code": "GBP"})).await;
    let company = a.insert("Company", json!({"company_name": "HeatCo Services", "abbr": "HC", "default_currency": gbp["id"]})).await;
    let cid = uid(&company);
    let output_tax = uid(&a.find_one("Account", json!({"account_name": "Output Tax", "company": cid.to_string()})).await);
    a.insert(
        "TaxTemplate",
        json!({"title": "VAT 20%", "company": cid.to_string(), "kind": "Sales", "is_default": true,
               "rows": [{"charge_type": "On Net Total", "account": output_tax.to_string(), "description": "VAT 20%", "rate": "20"}]}),
    )
    .await;
    let all_wh = a.find_one("Warehouse", json!({"warehouse_name": "All Warehouses", "company": cid.to_string()})).await;
    let van = |name: &'static str| {
        let (a, all_wh) = (a, &all_wh);
        async move { uid(&a.insert("Warehouse", json!({"warehouse_name": name, "company": cid.to_string(), "parent_warehouse": all_wh["id"]})).await) }
    };
    let (van_alice, van_bob) = (van("Van Alice").await, van("Van Bob").await);
    let products = a.find_one("ItemGroup", json!({"group_name": "Products"})).await;
    let services = a.find_one("ItemGroup", json!({"group_name": "Services"})).await;
    let nos = a.find_one("Uom", json!({"uom_name": "Nos"})).await;
    let hour = a.find_one("Uom", json!({"uom_name": "Hour"})).await;
    let item = |code: &'static str, extra: Value| {
        let (a, products, nos) = (a, &products, &nos);
        async move {
            let mut v = json!({"item_code": code, "item_name": code.to_lowercase(), "item_group": products["id"], "stock_uom": nos["id"]});
            for (key, x) in extra.as_object().unwrap() {
                v[key] = x.clone();
            }
            uid(&a.insert("Item", v).await)
        }
    };
    let labour = item("LABOUR", json!({"is_stock_item": false, "item_group": services["id"], "stock_uom": hour["id"], "item_name": "Engineer labour"})).await;
    let expenses = item("EXPENSES", json!({"is_stock_item": false, "item_group": services["id"], "item_name": "Rechargeable expenses"})).await;
    let boiler = item("BOILER", json!({"is_stock_item": false, "item_name": "Combi boiler"})).await;
    let filter = item("FILTER", json!({"item_name": "Magnetic filter"})).await;
    let valve = item("VALVE", json!({"item_name": "Diverter valve"})).await;
    let pump = item("PUMP", json!({"item_name": "Circulating pump", "has_serial_no": true})).await;
    let selling = a.find_one("PriceList", json!({"price_list_name": "Standard Selling"})).await;
    for (it, rate) in [(filter, "25"), (valve, "40"), (pump, "180")] {
        a.insert("ItemPrice", json!({"item": it.to_string(), "price_list": selling["id"], "rate": rate, "valid_from": "2020-01-01"})).await;
    }
    let opening = a
        .insert(
            "StockEntry",
            json!({"company": cid.to_string(), "purpose": "Opening Stock", "items": [
                {"item": filter.to_string(), "qty": "10", "basic_rate": "8", "target_warehouse": van_alice.to_string()},
                {"item": valve.to_string(), "qty": "2", "basic_rate": "15", "target_warehouse": van_alice.to_string()},
                {"item": pump.to_string(), "qty": "1", "basic_rate": "90", "serial_no": "PMP-1", "target_warehouse": van_alice.to_string()},
                {"item": filter.to_string(), "qty": "5", "basic_rate": "8", "target_warehouse": van_bob.to_string()}]}),
        )
        .await;
    a.submit("StockEntry", uid(&opening)).await;
    let every_day = |from: &str, to: &str| -> Value {
        Value::Array(
            ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
                .iter()
                .map(|d| json!({"weekday": d, "start_time": from, "end_time": to}))
                .collect(),
        )
    };

    // ───────────── field service setup, with its refusals ─────────────
    a.insert(
        "FieldServiceSettings",
        json!({"labour_item": labour.to_string(), "expense_item": expenses.to_string(), "labour_increment_minutes": 15, "travel_speed_kmh": "40",
               "require_checklist": true, "require_signature": true,
               "sla_targets": [{"priority": "Urgent", "response_hours": "2", "resolution_hours": "8"}, {"priority": "High", "response_hours": "4", "resolution_hours": "24"},
                               {"priority": "Medium", "response_hours": "8", "resolution_hours": "48"}, {"priority": "Low", "response_hours": "24", "resolution_hours": "72"}],
               "default_working_hours": every_day("07:00", "19:00")}),
    )
    .await;
    let settings_id = uid(&a.find_one("FieldServiceSettings", json!({})).await);
    let twice = a
        .try_update(
            "FieldServiceSettings",
            settings_id,
            json!({"sla_targets": [
        {"priority": "High", "response_hours": "4", "resolution_hours": "24"}, {"priority": "High", "response_hours": "2", "resolution_hours": "8"}]}),
        )
        .await;
    assert!(refused(&twice, "priority"), "one target per priority: {twice:?}");
    let backwards =
        a.try_update("FieldServiceSettings", settings_id, json!({"sla_targets": [{"priority": "High", "response_hours": "8", "resolution_hours": "4"}]})).await;
    assert!(refused(&backwards, "resolution_after_response"), "{backwards:?}");
    let north = uid(&a.insert("ServiceTerritory", json!({"territory_name": "North London"})).await);
    let south = uid(&a.insert("ServiceTerritory", json!({"territory_name": "South London"})).await);
    let skill = |name: &'static str| async move { uid(&a.insert("ServiceSkill", json!({"skill_name": name})).await) };
    let (gas, hvac, electrical) = (skill("Gas Safe").await, skill("HVAC").await, skill("Electrical").await);

    let manager = a.user("manager@heatco.test", &["Service Manager"]).await;
    let dispatcher = a.user("dispatch@heatco.test", &["Dispatcher"]).await;
    let alice_u = a.user("alice@heatco.test", &["Technician"]).await;
    let bob_u = a.user("bob@heatco.test", &["Technician"]).await;
    let carol_u = a.user("carol@heatco.test", &["Technician"]).await;
    let d = &dispatcher;

    let stranger = manager.try_insert("Technician", json!({"technician_name": "Nobody", "user_email": "nobody@heatco.test"})).await;
    assert!(refused(&stranger, "user_email"), "a technician signs in as a user: {stranger:?}");
    let bad_zone = manager.try_insert("Technician", json!({"technician_name": "Zed", "time_zone": "Mars/Olympus"})).await;
    assert!(refused(&bad_zone, "time_zone"), "{bad_zone:?}");
    let bad_hours = manager
        .try_insert("Technician", json!({"technician_name": "Zed", "working_hours": [{"weekday": "Monday", "start_time": "18:00", "end_time": "09:00"}]}))
        .await;
    assert!(refused(&bad_hours, "end_time"), "{bad_hours:?}");
    let tech = |name: &'static str, email: &'static str, territory: Uuid, skills: Vec<Uuid>, rates: (&str, &str), home: (&str, &str), extra: Value| {
        let manager = &manager;
        let (bill, cost) = (rates.0.to_string(), rates.1.to_string());
        let (lat, lng) = (home.0.to_string(), home.1.to_string());
        async move {
            let mut v = json!({"technician_name": name, "user_email": email, "territory": territory.to_string(), "bill_rate": bill, "hourly_cost": cost,
                               "home_latitude": lat, "home_longitude": lng,
                               "skills": skills.iter().map(|s| json!({"skill": s.to_string()})).collect::<Vec<_>>()});
            for (key, x) in extra.as_object().unwrap() {
                v[key] = x.clone();
            }
            uid(&manager.insert("Technician", v).await)
        }
    };
    let alice = tech(
        "Alice Smith",
        "alice@heatco.test",
        north,
        vec![gas, hvac],
        ("80", "30"),
        ("51.50", "-0.12"),
        json!({"van_warehouse": van_alice.to_string(), "working_hours": every_day("08:00", "18:00")}),
    )
    .await;
    let bob =
        tech("Bob Jones", "bob@heatco.test", north, vec![gas, hvac], ("70", "28"), ("51.80", "-0.12"), json!({"van_warehouse": van_bob.to_string()})).await;
    let carol = tech("Carol White", "carol@heatco.test", south, vec![electrical], ("75", "30"), ("51.45", "-0.10"), json!({})).await;
    let tech_view = alice_u.get("Technician", bob).await;
    assert!(!tech_view.contains_key("hourly_cost") && tech_view["bill_rate"] == json!("70"), "costs are for managers: {tech_view:?}");

    let acme = uid(&a.insert("Customer", json!({"customer_name": "Acme Flats", "email": "ops@acme.test", "phone": "+44 20 7946 0000"})).await);
    let beta = uid(&a.insert("Customer", json!({"customer_name": "Beta Offices"})).await);
    let site = json!({"site_address": "1 High Street, London N1", "latitude": "51.55", "longitude": "-0.12", "territory": north.to_string()});
    let equipment = |serial: &'static str, warranty_end: NaiveDate| {
        let (d, site) = (d, site.clone());
        async move {
            let mut v = json!({"customer": acme.to_string(), "item": boiler.to_string(), "serial_no": serial, "install_date": (today() - Duration::days(400)).to_string(),
                               "warranty_end": warranty_end.to_string()});
            for (key, x) in site.as_object().unwrap() {
                v[key] = x.clone();
            }
            d.insert("CustomerEquipment", v).await
        }
    };
    let eq_new = equipment("BX-100", today() + Duration::days(365)).await;
    let eq_old = equipment("BX-200", today() - Duration::days(30)).await;
    let (eq_new, eq_old) = (uid(&eq_new), uid(&eq_old));
    assert_eq!(d.get("CustomerEquipment", eq_old).await["equipment_name"], json!("Combi boiler (BX-200)"));
    let clash = d.try_insert("CustomerEquipment", json!({"customer": beta.to_string(), "item": boiler.to_string(), "serial_no": "BX-200"})).await;
    assert!(matches!(clash, Err(Error::Conflict(_))), "a serial number is one unit: {clash:?}");
    let template = uid(&manager
        .insert("ServiceChecklistTemplate", json!({"template_name": "Boiler service", "items": [
            {"task": "Check system pressure", "required": true}, {"task": "Inspect the flue", "required": true}, {"task": "Bleed radiators", "required": false}]}))
        .await);

    // ───────────── a phoned-in request becomes a work order ─────────────
    let req = d
        .insert(
            "ServiceRequest",
            json!({"subject": "No hot water", "customer": acme.to_string(), "equipment": eq_old.to_string(), "priority": "High",
                                         "source": "Phone", "contact_name": "Pat"}),
        )
        .await;
    let req_id = uid(&req);
    assert_eq!(
        (req["contact_email"].clone(), req["site_address"].clone(), req["territory"].clone()),
        (json!("ops@acme.test"), json!("1 High Street, London N1"), json!(north.to_string())),
        "contact and site come from the customer and equipment"
    );
    let made = d.act("ServiceRequest", req_id, "make_work_order", json!({})).await;
    let wo1 = vid(&made["id"]);
    assert_eq!(d.get("ServiceWorkOrder", wo1).await["company"], json!(cid.to_string()), "the only company is everyone's default");
    let again = d.try_act("ServiceRequest", req_id, "make_work_order", json!({"company": cid.to_string()})).await;
    assert!(again.is_err(), "a request becomes one work order: {again:?}");
    let r = d.get("ServiceRequest", req_id).await;
    assert_eq!((r["status"].clone(), r["work_order"].clone()), (json!("Converted"), json!(wo1.to_string())));
    let w = d.get("ServiceWorkOrder", wo1).await;
    assert!(w["number"].as_str().unwrap().starts_with("FSWO-"), "{}", w["number"]);
    assert_eq!(w["status"], json!("New"));
    assert_eq!(w["reported_at"], r["requested_at"], "the SLA counts from the customer's call");
    let reported = DateTime::parse_from_rfc3339(w["reported_at"].as_str().unwrap()).unwrap().with_timezone(&Utc);
    assert_eq!((w["response_hours"].clone(), w["resolution_hours"].clone()), (json!("4"), json!("24")));
    assert_eq!(w["response_due"], json!(iso(reported + Duration::hours(4))));
    assert_eq!((w["sla_status"].clone(), w["under_warranty"].clone(), w["parts_covered"].clone()), (json!("On Track"), json!(false), json!(false)));
    assert_eq!((w["latitude"].clone(), w["territory"].clone(), w["estimated_duration_minutes"].clone()), (json!("51.55"), json!(north.to_string()), json!(60)));
    let w = d
        .update(
            "ServiceWorkOrder",
            wo1,
            json!({"checklist_template": template.to_string(),
                                                "required_skills": [{"skill": gas.to_string()}, {"skill": hvac.to_string()}]}),
        )
        .await;
    let tasks: Vec<Value> = w["checklist"].as_array().unwrap().iter().map(|r| r["task"].clone()).collect();
    assert_eq!(tasks, [json!("Check system pressure"), json!("Inspect the flue"), json!("Bleed radiators")]);

    // ───────────── who should go? ─────────────
    let (slot, slot_end) = (at(1, 10, 0), at(1, 12, 0));
    let hidden = alice_u.try_act("ServiceWorkOrder", wo1, "suggest_technicians", json!({})).await;
    assert!(matches!(hidden, Err(Error::NotFound(_))), "unassigned technicians do not see the job: {hidden:?}");
    let ranking = d.act("ServiceWorkOrder", wo1, "suggest_technicians", json!({"start": iso(slot), "duration_minutes": 120})).await;
    assert_eq!(ranking["end"], json!(iso(slot_end)));
    let ranked = ranking["technicians"].as_array().unwrap();
    let names: Vec<&str> = ranked.iter().map(|r| r["technician_name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Alice Smith", "Bob Jones", "Carol White"]);
    assert_eq!((ranked[0]["eligible"].clone(), ranked[0]["score"].clone()), (json!(true), json!(97)));
    assert_eq!((dec(&ranked[0]["distance_km"]), ranked[0]["travel_minutes"].clone(), ranked[0]["travel_from"].clone()), (n("5.56"), json!(9), json!("home")));
    assert_eq!(ranked[0]["reasons"], json!(["works in the work order's territory", "within working hours", "5.56 km from home, about 9 min"]));
    assert_eq!((dec(&ranked[1]["distance_km"]), ranked[1]["travel_minutes"].clone(), ranked[1]["score"].clone()), (n("27.8"), json!(42), json!(86)));
    assert_eq!(ranked[2]["eligible"], json!(false));
    assert!(
        ranked[2]["reasons"][0] == json!("missing skills: Gas Safe, HVAC") && ranked[2]["reasons"][1] == json!("works in another territory (South London)"),
        "{}",
        ranked[2]
    );

    // ───────────── scheduled, dispatched, on the way, on site ─────────────
    let refused_schedule = alice_u.try_act("ServiceWorkOrder", wo1, "schedule", json!({"technician": alice.to_string(), "start": iso(slot)})).await;
    assert!(matches!(refused_schedule, Err(Error::NotFound(_))), "{refused_schedule:?}");
    let booked = d.act("ServiceWorkOrder", wo1, "schedule", json!({"technician": alice.to_string(), "start": iso(slot), "duration_minutes": 120})).await;
    let appt1 = vid(&booked["id"]);
    assert_eq!((booked["status"].clone(), booked["scheduled_end"].clone()), (json!("Scheduled"), json!(iso(slot_end))));
    let w = alice_u.get("ServiceWorkOrder", wo1).await;
    assert_eq!(
        (w["status"].clone(), w["crew"][0]["technician"].clone(), w["scheduled_start"].clone()),
        (json!("Scheduled"), json!(alice.to_string()), json!(iso(slot)))
    );
    assert!(matches!(bob_u.try_get("ServiceWorkOrder", wo1).await, Err(Error::NotFound(_))), "other technicians do not see it");
    assert_eq!(bob_u.list("ServiceWorkOrder", json!({})).await.len(), 0);
    assert_eq!(bob_u.list("ServiceAppointment", json!({})).await.len(), 0);
    assert_eq!(alice_u.list("ServiceAppointment", json!({})).await.len(), 1);
    let wrong = bob_u.try_act("ServiceWorkOrder", wo1, "arrive", json!({})).await;
    assert!(matches!(wrong, Err(Error::NotFound(_))), "the wrong technician cannot touch it: {wrong:?}");
    let self_dispatch = alice_u.try_act("ServiceWorkOrder", wo1, "dispatch", json!({})).await;
    assert!(matches!(self_dispatch, Err(Error::Forbidden(_))), "{self_dispatch:?}");
    let early = alice_u.try_act("ServiceWorkOrder", wo1, "start_travel", json!({})).await;
    assert!(early.is_err(), "travel starts after dispatch: {early:?}");
    let sent = d.act("ServiceWorkOrder", wo1, "dispatch", json!({})).await;
    assert_eq!((sent["status"].clone(), sent["customer_emailed"].clone()), (json!("Dispatched"), json!(false)), "without the Mail app nobody is emailed");
    let alice_notes = admin.notifications(alice_u.ctx.user).await;
    assert!(alice_notes.iter().any(|t| t.contains("dispatched to you")), "{alice_notes:?}");
    assert_eq!(alice_u.act("ServiceWorkOrder", wo1, "start_travel", json!({})).await["status"], json!("En Route"));
    assert_eq!(alice_u.act("ServiceWorkOrder", wo1, "arrive", json!({})).await["status"], json!("On Site"));
    let w = alice_u.get("ServiceWorkOrder", wo1).await;
    assert!(w["arrived_at"].is_string() && w["travel_started_at"].is_string());
    assert_eq!((w["response_breached"].clone(), w["sla_status"].clone()), (json!(false), json!("On Track")), "on site within four hours");
    let moved = d.try_update("ServiceAppointment", appt1, json!({"scheduled_start": iso(at(1, 13, 0)), "scheduled_end": iso(at(1, 14, 0))})).await;
    assert!(says(&moved, "cannot be moved"), "a visit under way stays where it is: {moved:?}");
    let gone = d.k.delete(&d.ctx, "ServiceAppointment", appt1, None).await;
    assert!(says(&gone, "cannot be deleted") || says(&gone, "only appointments"), "{gone:?}");

    // ───────────── on site: checklist, parts, time, expenses ─────────────
    let mut checklist = w["checklist"].as_array().unwrap().clone();
    checklist[0]["done"] = json!(true);
    let now = Utc::now();
    let work = json!({
        "checklist": checklist,
        "parts": [{"item": filter.to_string(), "qty": "2"}, {"item": valve.to_string(), "qty": "3", "warranty": true}],
        "labour": [{"from_time": iso(now - Duration::minutes(120)), "to_time": iso(now - Duration::minutes(30))}],
        "expenses": [{"expense_type": "Parking", "description": "Pay and display", "amount": "12.50"}, {"expense_type": "Meals", "amount": "20", "billable": false}],
        "work_notes": "Replaced the diverter valve; cleaned the filter.",
    });
    let w = alice_u.update("ServiceWorkOrder", wo1, work).await;
    assert_eq!(w["checklist"][0]["done_by"], json!("alice@heatco.test"));
    assert!(w["checklist"][0]["done_at"].is_string() && w["checklist"][1]["done_at"].is_null());
    assert_eq!(
        (w["parts"][0]["warehouse"].clone(), w["labour"][0]["technician"].clone()),
        (json!(van_alice.to_string()), json!(alice.to_string())),
        "her van, her time"
    );
    assert_eq!((dec(&w["labour"][0]["hours"]), dec(&w["labour"][0]["bill_rate"])), (n("1.5"), n("80")));
    assert!(!w["labour"][0].as_object().unwrap().contains_key("cost_rate") && !w.contains_key("labour_cost"), "technicians see no costs");
    assert_eq!((dec(&w["labour_hours"]), dec(&w["billable_hours"]), dec(&w["expense_total"])), (n("1.5"), n("1.5"), n("32.5")));
    assert_eq!(dec(&manager.get("ServiceWorkOrder", wo1).await["labour_cost"]), n("45"), "1.5 h at 30");
    let promote = alice_u.try_update("ServiceWorkOrder", wo1, json!({"priority": "Urgent"})).await;
    assert!(says(&promote, "not permitted"), "planning fields are the dispatcher's: {promote:?}");
    let mut for_bob = w["labour"].as_array().unwrap().clone();
    for_bob.push(json!({"technician": bob.to_string(), "from_time": iso(now - Duration::minutes(60)), "to_time": iso(now)}));
    let not_crew = alice_u.try_update("ServiceWorkOrder", wo1, json!({"labour": for_bob})).await;
    assert!(says(&not_crew, "is not assigned to this work order"), "{not_crew:?}");

    // ───────────── completion refused until the job is really done ─────────────
    let incomplete = alice_u.try_act("ServiceWorkOrder", wo1, "complete", json!({})).await;
    match &incomplete {
        Err(Error::Validation(e)) => {
            let fields: Vec<&str> = e.iter().map(|f| f.field.as_str()).collect();
            assert!(fields.contains(&"done") && fields.contains(&"customer_signature") && fields.contains(&"signed_by"), "{e:?}");
            assert!(e.iter().any(|f| f.message.contains("Inspect the flue") && f.row == Some(("checklist".into(), 1))), "{e:?}");
        }
        other => panic!("completion without checklist and signature: {other:?}"),
    }
    checklist = w["checklist"].as_array().unwrap().clone();
    checklist[1]["done"] = json!(true);
    let pdf = alice_u.upload("ServiceWorkOrder", wo1, "notes.pdf", "application/pdf").await;
    let not_image = alice_u.try_update("ServiceWorkOrder", wo1, json!({"customer_signature": pdf})).await;
    assert!(refused(&not_image, "customer_signature"), "{not_image:?}");
    let signature = alice_u.upload("ServiceWorkOrder", wo1, "signature.png", "image/png").await;
    let w = alice_u.update("ServiceWorkOrder", wo1, json!({"checklist": checklist, "customer_signature": signature, "signed_by": "Pat Morgan"})).await;
    assert!(w["signed_at"].is_string());
    let short = alice_u.try_act("ServiceWorkOrder", wo1, "complete", json!({})).await;
    match &short {
        Err(Error::Validation(e)) => {
            assert!(e.iter().any(|f| f.message == "not enough stock in Van Alice: 2 available, 3 needed" && f.row == Some(("parts".into(), 1))), "{e:?}")
        }
        other => panic!("three valves from a van with two: {other:?}"),
    }
    assert_eq!(
        (admin.stock(valve, van_alice).await, alice_u.get("ServiceWorkOrder", wo1).await["status"].clone()),
        (n("2"), json!("On Site")),
        "nothing moved"
    );
    let mut parts = w["parts"].as_array().unwrap().clone();
    parts[1]["qty"] = json!("1");
    alice_u.update("ServiceWorkOrder", wo1, json!({"parts": parts})).await;
    let cogs_before = admin.gl("Cost of Goods Sold").await;
    let done = alice_u.act("ServiceWorkOrder", wo1, "complete", json!({})).await;
    assert_eq!((done["status"].clone(), done["first_time_fix"].clone()), (json!("Completed"), json!(true)));
    assert_eq!((admin.stock(filter, van_alice).await, admin.stock(valve, van_alice).await), (n("8"), n("1")), "the parts left the van");
    assert_eq!(admin.gl("Cost of Goods Sold").await - cogs_before, n("31"), "2 × 8 + 15 at valuation");
    let w = manager.get("ServiceWorkOrder", wo1).await;
    assert_eq!((dec(&w["parts_cost"]), dec(&w["parts"][0]["cost"]), dec(&w["parts"][1]["cost"])), (n("31"), n("16"), n("15")));
    assert_eq!((w["visits"].clone(), w["docstatus"].clone(), w["sla_status"].clone()), (json!(1), json!(1), json!("Met")));
    let se = admin.get("StockEntry", vid(&w["stock_entry"])).await;
    assert_eq!((se["purpose"].clone(), se["docstatus"].clone()), (json!("Material Issue"), json!(1)));
    assert_eq!(d.get("ServiceAppointment", appt1).await["status"], json!("Completed"));
    assert_eq!(d.get("CustomerEquipment", eq_old).await["last_service_date"], json!(today().to_string()));
    let frozen = alice_u.try_update("ServiceWorkOrder", wo1, json!({"work_notes": "edited later"})).await;
    assert!(says(&frozen, "cannot be edited"), "a completed work order is final: {frozen:?}");

    // ───────────── invoiced exactly once ─────────────
    let no_rights = alice_u.try_act("ServiceWorkOrder", wo1, "create_invoice", json!({})).await;
    assert!(matches!(no_rights, Err(Error::Forbidden(_))), "{no_rights:?}");
    let inv = manager.act("ServiceWorkOrder", wo1, "create_invoice", json!({})).await;
    let si = admin.get("SalesInvoice", vid(&inv["id"])).await;
    let lines: Vec<(Value, Decimal, Decimal, Decimal)> =
        si["items"].as_array().unwrap().iter().map(|l| (l["item"].clone(), dec(&l["qty"]), dec(&l["rate"]), dec(&l["amount"]))).collect();
    assert_eq!(
        lines,
        [
            (json!(filter.to_string()), n("2"), n("25"), n("50")),
            (json!(valve.to_string()), n("1"), n("0"), n("0")),
            (json!(labour.to_string()), n("1.5"), n("80"), n("120")),
            (json!(expenses.to_string()), n("1"), n("12.5"), n("12.5")),
        ],
        "parts at list price (the warranty valve free), 1.5 h × 80, parking at cost; the meal is not billable"
    );
    assert_eq!(si["items"][1]["discount_percent"], json!("100"));
    assert_eq!((dec(&si["net_total"]), dec(&si["total_taxes"]), dec(&si["grand_total"])), (n("182.5"), n("36.5"), n("219")));
    assert_eq!(manager.get("ServiceWorkOrder", wo1).await["status"], json!("Invoiced"));
    let twice = manager.try_act("ServiceWorkOrder", wo1, "create_invoice", json!({})).await;
    assert!(twice.is_err(), "invoiced once: {twice:?}");
    manager.k.delete(&manager.ctx, "SalesInvoice", vid(&inv["id"]), None).await.expect("drop the draft");
    let w = manager.get("ServiceWorkOrder", wo1).await;
    assert_eq!((w["status"].clone(), w["sales_invoice"].clone()), (json!("Completed"), Value::Null), "a deleted draft releases the work order");
    let gate = Arc::new(tokio::sync::Barrier::new(4));
    let tries: Vec<_> = (0..4)
        .map(|_| {
            let (m, gate) = (manager.clone(), gate.clone());
            tokio::spawn(async move {
                gate.wait().await;
                m.try_act("ServiceWorkOrder", wo1, "create_invoice", json!({})).await
            })
        })
        .collect();
    let mut invoices = Vec::new();
    for t in tries {
        if let Ok(v) = t.await.unwrap() {
            invoices.push(vid(&v["id"]));
        }
    }
    assert_eq!(invoices.len(), 1, "four clicks at once make one invoice");
    let made_for_wo = admin
        .count(
            "select count(*) from e_sales_invoice where tenant_id = $1 and remarks like '%' || (select number from e_service_work_order where id = $2) || '%'",
            wo1,
        )
        .await;
    assert_eq!(made_for_wo, 1);
    let posted = admin.submit("SalesInvoice", invoices[0]).await;
    assert_eq!(dec(&posted["outstanding_amount"]), n("219"));
    assert_eq!((admin.gl("Sales").await, admin.gl("Output Tax").await, admin.gl("Debtors").await), (n("-182.5"), n("-36.5"), n("219")));
    let undo = manager.k.cancel(&manager.ctx, "ServiceWorkOrder", wo1, None).await;
    assert!(says(&undo, "first"), "an invoiced completion stays: {undo:?}");
    admin.k.cancel(&admin.ctx, "SalesInvoice", invoices[0], None).await.expect("cancel the invoice");
    assert_eq!(manager.get("ServiceWorkOrder", wo1).await["status"], json!("Completed"), "a cancelled invoice releases it");
    let again = manager.act("ServiceWorkOrder", wo1, "create_invoice", json!({})).await;
    assert_eq!(dec(&admin.get("SalesInvoice", vid(&again["id"])).await["grand_total"]), n("219"), "invoiced again, to the penny");

    // ───────────── warranty work is free ─────────────
    let wo2 = uid(&d
        .insert(
            "ServiceWorkOrder",
            json!({"company": cid.to_string(), "customer": acme.to_string(), "equipment": eq_new.to_string(),
                                                        "priority": "Medium", "description": "Boiler lockout"}),
        )
        .await);
    let w = d.get("ServiceWorkOrder", wo2).await;
    assert_eq!((w["under_warranty"].clone(), w["parts_covered"].clone(), w["labour_covered"].clone()), (json!(true), json!(true), json!(true)));
    d.act("ServiceWorkOrder", wo2, "schedule", json!({"technicians": [bob.to_string()], "start": iso(at(1, 14, 0)), "end": iso(at(1, 15, 0))})).await;
    d.act("ServiceWorkOrder", wo2, "dispatch", json!({})).await;
    assert_eq!(bob_u.act("ServiceWorkOrder", wo2, "arrive", json!({})).await["status"], json!("On Site"), "straight from dispatch to the site");
    let sig = bob_u.upload("ServiceWorkOrder", wo2, "sig.png", "image/png").await;
    bob_u
        .update(
            "ServiceWorkOrder",
            wo2,
            json!({"parts": [{"item": filter.to_string(), "qty": "1"}],
            "labour": [{"from_time": iso(now - Duration::minutes(90)), "to_time": iso(now - Duration::minutes(60))}],
            "expenses": [{"expense_type": "Parking", "amount": "5"}], "customer_signature": sig, "signed_by": "Pat Morgan"}),
        )
        .await;
    bob_u.act("ServiceWorkOrder", wo2, "complete", json!({})).await;
    assert_eq!(admin.stock(filter, van_bob).await, n("4"), "from Bob's van");
    let inv2 = admin.get("SalesInvoice", vid(&manager.act("ServiceWorkOrder", wo2, "create_invoice", json!({})).await["id"])).await;
    assert_eq!((dec(&inv2["items"][0]["amount"]), dec(&inv2["items"][1]["amount"]), dec(&inv2["items"][1]["qty"])), (n("0"), n("0"), n("0.5")));
    assert_eq!((dec(&inv2["net_total"]), dec(&inv2["grand_total"])), (n("5"), n("6")), "only the parking is charged");
    assert!(inv2["items"][1]["description"].as_str().unwrap().contains("under warranty"));

    // ───────────── double booking is impossible, even all at once ─────────────
    let mut jobs = Vec::new();
    for i in 0..6 {
        jobs.push(uid(&d
            .insert(
                "ServiceWorkOrder",
                json!({"company": cid.to_string(), "customer": beta.to_string(), "priority": "Low",
                                                           "description": format!("Socket {i}"), "latitude": "51.46", "longitude": "-0.11"}),
            )
            .await));
    }
    let (s9, s11, s13) = (at(2, 9, 0), at(2, 11, 0), at(2, 13, 0));
    let gate = Arc::new(tokio::sync::Barrier::new(6));
    let rush: Vec<_> = jobs
        .iter()
        .map(|job| {
            let (d, gate, job) = (dispatcher.clone(), gate.clone(), *job);
            tokio::spawn(async move {
                gate.wait().await;
                (job, d.try_act("ServiceWorkOrder", job, "schedule", json!({"technician": carol.to_string(), "start": iso(s9), "end": iso(s11)})).await)
            })
        })
        .collect();
    let mut won = Vec::new();
    for r in rush {
        match r.await.unwrap() {
            (job, Ok(_)) => won.push(job),
            (_, Err(e)) => assert!(format!("{e:?}").contains("is already booked"), "refused with the reason: {e:?}"),
        }
    }
    assert_eq!(won.len(), 1, "six dispatchers, one slot: one booking");
    let busy = "select count(*) from e_service_appointment__technicians where tenant_id = $1 and technician = $2 and busy";
    assert_eq!(admin.count(busy, carol).await, 1);
    let rest: Vec<Uuid> = jobs.iter().copied().filter(|j| *j != won[0]).collect();
    d.act("ServiceWorkOrder", rest[0], "schedule", json!({"technician": carol.to_string(), "start": iso(s11), "end": iso(s13)})).await;
    let overlap = d
        .try_act("ServiceWorkOrder", rest[1], "schedule", json!({"technician": carol.to_string(), "start": iso(s11 - Duration::minutes(1)), "end": iso(s13)}))
        .await;
    assert!(says(&overlap, "is already booked"), "back to back is fine, a minute of overlap is not: {overlap:?}");
    // The database itself refuses an overlapping busy row, whatever writes it.
    let winner_appt = vid(&d.get("ServiceWorkOrder", won[0]).await["current_appointment"]);
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    let sneak = sqlx::query(
        "insert into e_service_appointment__technicians (tenant_id, id, parent_id, idx, technician, slot_start, slot_end, busy) values ($1, $2, $3, 9, $4, $5, $6, true)",
    )
    .bind(tenant)
    .bind(Uuid::now_v7())
    .bind(winner_appt)
    .bind(carol)
    .bind(s9 + Duration::minutes(30))
    .bind(s9 + Duration::minutes(60))
    .execute(&mut *tx)
    .await;
    assert!(matches!(&sneak, Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23P01")), "exclusion constraint: {sneak:?}");
    drop(tx);
    let cancel_refused = carol_u.try_act("ServiceWorkOrder", won[0], "cancel_work_order", json!({})).await;
    assert!(matches!(cancel_refused, Err(Error::Forbidden(_))), "{cancel_refused:?}");
    d.act("ServiceWorkOrder", won[0], "cancel_work_order", json!({"reason": "Customer fixed it"})).await;
    let cancelled = d.get("ServiceWorkOrder", won[0]).await;
    assert_eq!((cancelled["status"].clone(), cancelled["cancellation_reason"].clone()), (json!("Cancelled"), json!("Customer fixed it")));
    assert_eq!(d.get("ServiceAppointment", winner_appt).await["status"], json!("Cancelled"));
    let final_edit = d.try_update("ServiceWorkOrder", won[0], json!({"description": "Reopen?"})).await;
    assert!(says(&final_edit, "final"), "{final_edit:?}");
    let freed = d.act("ServiceWorkOrder", rest[1], "schedule", json!({"technician": carol.to_string(), "start": iso(s9), "end": iso(s11)})).await;
    assert_eq!(freed["status"], json!("Scheduled"), "the cancelled work order's slot is free again");
    // Moving a dispatched appointment sends it back to be dispatched again.
    d.act("ServiceWorkOrder", rest[1], "dispatch", json!({})).await;
    let appt = vid(&freed["id"]);
    let moved = d.update("ServiceAppointment", appt, json!({"scheduled_start": iso(at(2, 8, 0)), "scheduled_end": iso(at(2, 9, 0))})).await;
    assert_eq!((moved["status"].clone(), d.get("ServiceWorkOrder", rest[1]).await["status"].clone()), (json!("Scheduled"), json!("Scheduled")));
    let extra = vid(&d
        .act("ServiceWorkOrder", rest[2], "schedule", json!({"technician": carol.to_string(), "start": iso(s13), "end": iso(s13 + Duration::hours(1))}))
        .await["id"]);
    let not_hers = carol_u.try_act("ServiceAppointment", extra, "cancel_appointment", json!({})).await;
    assert!(matches!(not_hers, Err(Error::Forbidden(_))), "technicians do not cancel visits: {not_hers:?}");
    assert_eq!(d.act("ServiceAppointment", extra, "cancel_appointment", json!({})).await["status"], json!("Cancelled"));
    let w = d.get("ServiceWorkOrder", rest[2]).await;
    assert_eq!(
        (w["status"].clone(), w["current_appointment"].clone(), w["crew"].as_array().unwrap().len()),
        (json!("New"), Value::Null, 0),
        "back to unscheduled"
    );
    assert_eq!(admin.count(busy, carol).await, 2, "its time is free");

    // ───────────── maintenance plans: every visit once ─────────────
    let start = today() - Duration::days(35);
    let plan = |start: NaiveDate, end: NaiveDate, value: &str, equipment: Option<Uuid>| {
        let manager = &manager;
        let value = value.to_string();
        async move {
            let c = manager
                .insert(
                    "ServiceContract",
                    json!({"company": cid.to_string(), "customer": acme.to_string(), "equipment": equipment.map(|e| e.to_string()),
                    "start_date": start.to_string(), "end_date": end.to_string(), "frequency": "Weeks", "repeat_every": 2, "lead_days": 7,
                    "sla_response_hours": "3", "sla_resolution_hours": "12", "contract_value": value, "covers_labour": true,
                    "checklist_template": template.to_string(), "priority": "Medium"}),
                )
                .await;
            uid(&manager.submit("ServiceContract", uid(&c)).await)
        }
    };
    let c1 = plan(start, today() + Duration::days(200), "1200", Some(eq_old)).await;
    let c1_doc = manager.get("ServiceContract", c1).await;
    assert_eq!((c1_doc["status"].clone(), c1_doc["next_due_date"].clone()), (json!("Active"), json!(start.to_string())));
    let wrong_owner = manager
        .try_insert(
            "ServiceContract",
            json!({"company": cid.to_string(), "customer": beta.to_string(), "equipment": eq_old.to_string(),
            "start_date": start.to_string(), "end_date": today().to_string()}),
        )
        .await;
    assert!(refused(&wrong_owner, "equipment"), "{wrong_owner:?}");
    ferrum_app_field_service::maintenance(&k).await.expect("maintenance");
    ferrum_app_field_service::maintenance(&k).await.expect("again");
    let (x, y, z) =
        tokio::join!(ferrum_app_field_service::maintenance(&k), ferrum_app_field_service::maintenance(&k), ferrum_app_field_service::maintenance(&k));
    x.and(y).and(z).expect("at once");
    let planned = manager.list("ServiceWorkOrder", json!({"service_contract": c1.to_string(), "contract_due_date": ["is", "set"]})).await;
    let mut due: Vec<String> = planned.iter().map(|w| w["contract_due_date"].as_str().unwrap().to_string()).collect();
    due.sort();
    let expected: Vec<String> = [0, 14, 28, 42].iter().map(|days| (start + Duration::days(*days)).to_string()).collect();
    assert_eq!(due, expected, "visits due up to a week ahead, each once, however often maintenance runs");
    let c1_doc = manager.get("ServiceContract", c1).await;
    assert_eq!((c1_doc["occurrences"].clone(), c1_doc["next_due_date"].clone()), (json!(4), json!((start + Duration::days(56)).to_string())));
    let visit = manager.get("ServiceWorkOrder", uid(&planned[0])).await;
    assert_eq!(
        (visit["work_type"].clone(), visit["response_hours"].clone(), visit["labour_covered"].clone(), visit["parts_covered"].clone()),
        (json!("Maintenance"), json!("3"), json!(true), json!(false)),
        "the contract's SLA and coverage"
    );
    assert_eq!(visit["checklist"].as_array().unwrap().len(), 3);
    let overdue = planned.iter().filter(|w| w["sla_status"] == json!("Breached")).count();
    assert_eq!(overdue, 3, "visits whose due day passed long ago are already late");
    let reactive = uid(&d
        .insert("ServiceWorkOrder", json!({"company": cid.to_string(), "customer": acme.to_string(), "equipment": eq_old.to_string(), "priority": "Low"}))
        .await);
    let w = d.get("ServiceWorkOrder", reactive).await;
    assert_eq!(
        (w["service_contract"].clone(), w["response_hours"].clone(), w["labour_covered"].clone()),
        (json!(c1.to_string()), json!("3"), json!(true)),
        "a breakdown under contract gets the contract's response time instead of Low's 24 hours"
    );
    let c2 = plan(today() - Duration::days(10), today() + Duration::days(10), "300", None).await;
    admin.exec("update e_service_contract set end_date = current_date - 30 where tenant_id = $1 and id = $2", c2).await;
    ferrum_app_field_service::maintenance(&k).await.expect("maintenance");
    assert_eq!(manager.get("ServiceContract", c2).await["status"], json!("Expired"));

    // ───────────── service levels judged as time passes ─────────────
    let late = uid(&d
        .insert(
            "ServiceWorkOrder",
            json!({"company": cid.to_string(), "customer": beta.to_string(), "priority": "Urgent",
                                                        "reported_at": iso(now - Duration::hours(3)), "description": "Gas smell"}),
        )
        .await);
    let w = d.get("ServiceWorkOrder", late).await;
    assert_eq!((w["response_breached"].clone(), w["resolution_breached"].clone(), w["sla_status"].clone()), (json!(true), json!(false), json!("Breached")));
    let future =
        d.try_insert("ServiceWorkOrder", json!({"company": cid.to_string(), "customer": beta.to_string(), "reported_at": iso(now + Duration::hours(2))})).await;
    assert!(refused(&future, "reported_at"), "{future:?}");
    let risky = uid(&d
        .insert(
            "ServiceWorkOrder",
            json!({"company": cid.to_string(), "customer": beta.to_string(), "priority": "High",
                                                         "reported_at": iso(now - Duration::minutes(210))}),
        )
        .await);
    assert_eq!(d.get("ServiceWorkOrder", risky).await["sla_status"], json!("At Risk"), "half an hour of four left");
    let slow = uid(&d
        .insert("ServiceWorkOrder", json!({"company": cid.to_string(), "customer": beta.to_string(), "priority": "High", "description": "Radiator cold"}))
        .await);
    assert_eq!(d.get("ServiceWorkOrder", slow).await["sla_status"], json!("On Track"));
    // Thirty hours pass.
    admin
        .exec(
            "update e_service_work_order set reported_at = reported_at - interval '30 hours', sla_start = sla_start - interval '30 hours', \
             response_due = response_due - interval '30 hours', resolution_due = resolution_due - interval '30 hours' where tenant_id = $1 and id = $2",
            slow,
        )
        .await;
    ferrum_app_field_service::maintenance(&k).await.expect("sla refresh");
    let w = d.get("ServiceWorkOrder", slow).await;
    assert_eq!((w["response_breached"].clone(), w["resolution_breached"].clone(), w["sla_status"].clone()), (json!(true), json!(true), json!("Breached")));
    let breaches = admin.notifications(dispatcher.ctx.user).await.iter().filter(|t| t.starts_with("SLA breached")).count();
    assert!(breaches >= 1, "the dispatcher who logged it hears of the breach");
    ferrum_app_field_service::maintenance(&k).await.expect("again");
    assert_eq!(admin.notifications(dispatcher.ctx.user).await.iter().filter(|t| t.starts_with("SLA breached")).count(), breaches, "announced once");
    let events = admin.count("select count(*) from outbox where tenant_id = $1 and record_id = $2 and topic = 'ServiceWorkOrder.updated'", slow).await;
    assert_eq!(events, 1, "the verdict change is published once for automations and webhooks");

    // ───────────── a revisit is not a first-time fix ─────────────
    let wo4 = uid(&d
        .insert("ServiceWorkOrder", json!({"company": cid.to_string(), "customer": acme.to_string(), "equipment": eq_old.to_string(), "priority": "Medium"}))
        .await);
    d.act("ServiceWorkOrder", wo4, "schedule", json!({"technician": alice.to_string(), "start": iso(at(3, 9, 0))})).await;
    d.act("ServiceWorkOrder", wo4, "dispatch", json!({})).await;
    alice_u.act("ServiceWorkOrder", wo4, "arrive", json!({})).await;
    let first_visit = vid(&d.get("ServiceWorkOrder", wo4).await["current_appointment"]);
    let revisit = d.act("ServiceWorkOrder", wo4, "schedule", json!({"technician": alice.to_string(), "start": iso(at(4, 9, 0))})).await;
    assert_eq!(revisit["status"], json!("Scheduled"), "parts are needed: another visit");
    assert_eq!(d.get("ServiceAppointment", first_visit).await["status"], json!("Cannot Complete"));
    d.act("ServiceWorkOrder", wo4, "dispatch", json!({})).await;
    alice_u.act("ServiceWorkOrder", wo4, "arrive", json!({})).await;
    let sig = alice_u.upload("ServiceWorkOrder", wo4, "sig.png", "image/png").await;
    alice_u
        .update(
            "ServiceWorkOrder",
            wo4,
            json!({"customer_signature": sig, "signed_by": "Pat Morgan", "expenses": [{"expense_type": "Parking", "amount": "10"}]}),
        )
        .await;
    // Invoicing on completion, with a gap in the settings: the job still completes, and says so.
    manager.update("FieldServiceSettings", settings_id, json!({"auto_invoice": true, "expense_item": null})).await;
    let done = alice_u.act("ServiceWorkOrder", wo4, "complete", json!({})).await;
    assert_eq!((done["status"].clone(), done["sales_invoice"].clone(), done["first_time_fix"].clone()), (json!("Completed"), Value::Null, json!(false)));
    assert_eq!(manager.get("ServiceWorkOrder", wo4).await["visits"], json!(2));
    let notes = admin.notifications(alice_u.ctx.user).await;
    assert!(notes.iter().any(|t| t.contains("not invoiced automatically: set the expense item")), "{notes:?}");
    manager.update("FieldServiceSettings", settings_id, json!({"expense_item": expenses.to_string()})).await;

    // ───────────── customers file and follow requests ─────────────
    let hidden = public(&k, tenant, "POST", "/requests", json!({"subject": "Leak", "contact_name": "Sam", "contact_email": "sam@example.test"})).await;
    assert!(matches!(hidden, Err(Error::NotFound(_))), "closed unless the settings open it: {hidden:?}");
    manager.update("FieldServiceSettings", settings_id, json!({"public_requests": true, "tracking_link_days": 14})).await;
    let missing = public(&k, tenant, "POST", "/requests", json!({"subject": "Leak", "contact_email": "sam@example.test"})).await;
    assert!(refused(&missing, "contact_name"), "{missing:?}");
    let filed = public(
        &k,
        tenant,
        "POST",
        "/requests",
        json!({"subject": "Boiler making noises", "contact_name": "Pat Morgan", "contact_email": "OPS@acme.test", "serial_no": "BX-200",
               "description": "Banging when the heating starts", "preferred_start": iso(at(1, 9, 0))}),
    )
    .await
    .expect("public request");
    assert_eq!(filed.status, 201);
    let filed = body(&filed);
    let web = d.find_one("ServiceRequest", json!({"number": filed["reference"].as_str().unwrap()})).await;
    assert_eq!(
        (web["source"].clone(), web["customer"].clone(), web["equipment"].clone()),
        (json!("Customer Portal"), json!(acme.to_string()), json!(eq_old.to_string())),
        "the email names the customer, whose unit the serial number is"
    );
    let path = filed["tracking_path"].as_str().unwrap().to_string();
    let token = path.rsplit('/').next().unwrap().to_string();
    assert!(path.starts_with("/api/site/heatco/field_service/track/"), "{path}");
    let follow = |token: String| {
        let k = k.clone();
        async move { public(&k, tenant, "GET", &format!("/track/{token}"), Value::Null).await }
    };
    let view = body(&follow(token.clone()).await.expect("track"));
    assert_eq!((view["status"].clone(), view["visit"].clone()), (json!("Open"), Value::Null));
    let web_wo = vid(&d.act("ServiceRequest", uid(&web), "make_work_order", json!({"company": cid.to_string()})).await["id"]);
    d.act("ServiceWorkOrder", web_wo, "schedule", json!({"technician": alice.to_string(), "start": iso(at(1, 15, 0))})).await;
    let view = body(&follow(token.clone()).await.expect("track"));
    assert_eq!(
        (view["status"].clone(), view["visit"]["status"].clone(), view["visit"]["technicians"].clone()),
        (json!("Converted"), json!("Scheduled"), json!(["Alice"])),
        "first names only"
    );
    assert!(!view.to_string().contains("alice@heatco.test") && !view.to_string().contains("80"), "no emails or rates: {view}");
    let html = call(&k, tenant, None, "GET", &format!("/track/{token}"), json!({}), vec![], "text/html").await.expect("page");
    assert!(html.content_type.starts_with("text/html") && String::from_utf8_lossy(&html.body).contains("Scheduled"));
    let tampered = format!("{}0", &token[..token.len() - 1]);
    assert!(matches!(follow(tampered).await, Err(Error::NotFound(_))));
    let expired = signed(&admin, uid(&web), Utc::now().timestamp() - 60).await;
    assert!(matches!(follow(expired).await, Err(Error::NotFound(_))), "expired links answer like unknown ones");
    let fresh = signed(&admin, uid(&web), Utc::now().timestamp() + 600).await;
    assert!(follow(fresh).await.is_ok(), "a link signed with the tenant's key works until it expires");
    d.act("ServiceWorkOrder", web_wo, "dispatch", json!({})).await;
    alice_u.act("ServiceWorkOrder", web_wo, "arrive", json!({})).await;
    let sig = alice_u.upload("ServiceWorkOrder", web_wo, "sig.png", "image/png").await;
    alice_u
        .update(
            "ServiceWorkOrder",
            web_wo,
            json!({"customer_signature": sig, "signed_by": "Pat Morgan", "expenses": [{"expense_type": "Tolls", "amount": "15"}]}),
        )
        .await;
    let done = alice_u.act("ServiceWorkOrder", web_wo, "complete", json!({})).await;
    assert_eq!(done["status"], json!("Invoiced"), "invoiced on completion");
    let auto = admin.get("SalesInvoice", vid(&done["sales_invoice"])).await;
    assert_eq!((dec(&auto["net_total"]), dec(&auto["grand_total"]), auto["docstatus"].clone()), (n("15"), n("18"), json!(0)), "a draft: the toll and its VAT");
    assert_eq!(body(&follow(token.clone()).await.expect("track"))["visit"]["status"], json!("Invoiced"));
    let link = d.act("ServiceRequest", req_id, "tracking_link", json!({"send": true})).await;
    assert_eq!(link["emailed"], json!(false), "without the Mail app the link is returned to copy");
    assert!(link["path"].as_str().unwrap().contains("/track/"));
    for i in 0..4 {
        public(&k, tenant, "POST", "/requests", json!({"subject": format!("Spam {i}"), "contact_name": "Pat", "contact_email": "ops@acme.test"}))
            .await
            .expect("within the limit");
    }
    let flood = public(&k, tenant, "POST", "/requests", json!({"subject": "Spam 5", "contact_name": "Pat", "contact_email": "ops@acme.test"})).await;
    assert!(matches!(flood, Err(Error::TooManyRequests(_))), "{flood:?}");
    let rejected =
        d.act("ServiceRequest", uid(&d.find_one("ServiceRequest", json!({"subject": "Spam 0"})).await), "reject", json!({"reason": "Duplicate"})).await;
    assert_eq!(rejected["status"], json!("Rejected"));

    // ───────────── the dispatch board ─────────────
    let day2 = today() + Duration::days(2);
    let board = d.board(day2, day2).await;
    let carol_day = board["technicians"].as_array().unwrap().iter().find(|t| t["technician_name"] == json!("Carol White")).unwrap().clone();
    let visits: Vec<(Value, Value)> = carol_day["appointments"].as_array().unwrap().iter().map(|v| (v["start"].clone(), v["status"].clone())).collect();
    assert_eq!(visits, [(json!(iso(at(2, 8, 0))), json!("Scheduled")), (json!(iso(s11)), json!("Scheduled"))], "the cancelled visit is gone");
    let first = &carol_day["appointments"][0];
    assert_eq!((first["travel"]["from"].clone(), first["travel"]["km"].clone()), (json!("home"), json!("1.31")), "from home to the first job");
    assert_eq!(carol_day["appointments"][1]["travel"]["from"], first["number"], "then from job to job");
    assert_eq!((dec(&carol_day["available_hours"]), dec(&carol_day["booked_hours"])), (n("12"), n("3")), "the default hours: 07:00-19:00");
    let open: Vec<Value> = board["unscheduled"].as_array().unwrap().iter().take(3).map(|w| w["work_order"].clone()).collect();
    assert_eq!(open, [json!(late.to_string()), json!(slow.to_string()), json!(risky.to_string())], "urgent first, then by response deadline");
    let mine = alice_u.board(day2, day2).await;
    assert_eq!(mine["technicians"].as_array().unwrap().len(), 1, "technicians see their own day");
    assert!(mine["unscheduled"].as_array().unwrap().is_empty());
    // Over the October DST weekend Alice's 08:00-18:00 moves an hour in UTC.
    let dst = d.board(NaiveDate::from_ymd_opt(2026, 10, 24).unwrap(), NaiveDate::from_ymd_opt(2026, 10, 25).unwrap()).await;
    let alice_days = dst["technicians"].as_array().unwrap().iter().find(|t| t["technician_name"] == json!("Alice Smith")).unwrap().clone();
    assert_eq!(
        alice_days["working_hours"],
        json!([{"start": "2026-10-24T07:00:00.000Z", "end": "2026-10-24T17:00:00.000Z"},
                                                   {"start": "2026-10-25T08:00:00.000Z", "end": "2026-10-25T18:00:00.000Z"}])
    );
    assert_eq!(dec(&alice_days["available_hours"]), n("20"));
    let too_long = d.site("GET", "/dispatch", json!({"from": "2026-01-01", "to": "2026-03-01"})).await;
    assert!(refused(&too_long, "to"), "{too_long:?}");
    let anonymous = public(&k, tenant, "GET", "/dispatch", Value::Null).await;
    assert!(matches!(anonymous, Err(Error::NotFound(_))), "the board is for signed-in users");

    // ───────────── reports ─────────────
    let span = [("from_date", (today() - Duration::days(1)).to_string()), ("to_date", (today() + Duration::days(1)).to_string())];
    let summary = d.report("fs_work_order_summary", &span).await.expect("summary");
    let all = admin.count("select count(*) from e_service_work_order where tenant_id = $1 and $2::uuid is not null", wo1).await;
    assert_eq!(summary["totals"]["work_orders"], json!(all));
    let status = |s: &str| summary["rows"].as_array().unwrap().iter().find(|r| r["group"] == json!(s)).map(|r| r["work_orders"].clone()).unwrap_or(json!(0));
    assert_eq!(
        (status("Invoiced"), status("Completed"), status("Cancelled")),
        (json!(3), json!(1), json!(1)),
        "wo1, the warranty job and the web job invoiced"
    );
    let by_tech = d.report("fs_first_time_fix", &[span[0].clone(), span[1].clone(), ("group_by", "Technician".into())]).await.expect("ftf");
    let row = |r: &Value, g: &str| r["rows"].as_array().unwrap().iter().find(|x| x["group"] == json!(g)).cloned().unwrap_or_else(|| panic!("{g}: {r}"));
    let alice_ftf = row(&by_tech, "Alice Smith");
    assert_eq!(
        (alice_ftf["completed"].clone(), alice_ftf["first_time_fixes"].clone(), dec(&alice_ftf["first_time_fix_rate"])),
        (json!(3), json!(2), n("66.67"))
    );
    assert_eq!((by_tech["totals"]["completed"].clone(), by_tech["totals"]["first_time_fixes"].clone()), (json!(4), json!(3)));
    let sla = d.report("fs_sla_compliance", &span).await.expect("sla");
    let high = row(&sla, "High");
    assert_eq!(
        (high["work_orders"].clone(), high["response_met"].clone(), high["response_breached"].clone(), high["response_pending"].clone()),
        (json!(3), json!(1), json!(1), json!(1)),
        "wo1 met, the slow one breached, the risky one pending"
    );
    assert_eq!((high["resolution_met"].clone(), high["resolution_breached"].clone(), dec(&high["response_pct"])), (json!(1), json!(1), n("50")));
    let util = manager.report("fs_technician_utilization", &span).await.expect("utilization");
    let alice_util = util["rows"].as_array().unwrap().iter().find(|r| r["technician"] == json!("Alice Smith")).unwrap().clone();
    assert_eq!((dec(&alice_util["available_hours"]), dec(&alice_util["worked_hours"]), dec(&alice_util["utilization_pct"])), (n("30"), n("1.5"), n("5")));
    assert_eq!((dec(&alice_util["scheduled_hours"]), alice_util["jobs_completed"].clone()), (n("3"), json!(3)), "two hours for Acme, one for the web request");
    let own_util = alice_u.report("fs_technician_utilization", &span).await.expect("own utilization");
    assert_eq!(own_util["rows"].as_array().unwrap().len(), 1);
    let parts = manager.report("fs_parts_consumption", &span).await.expect("parts");
    let filter_row = parts["rows"].as_array().unwrap().iter().find(|r| r["item_code"] == json!("FILTER")).unwrap().clone();
    assert_eq!(
        (dec(&filter_row["qty"]), dec(&filter_row["free_qty"]), dec(&filter_row["cost"]), filter_row["work_orders"].clone()),
        (n("3"), n("1"), n("24"), json!(2))
    );
    assert_eq!((dec(&parts["totals"]["qty"]), dec(&parts["totals"]["cost"])), (n("4"), n("39")));
    let parts_blind = d.report("fs_parts_consumption", &span).await.expect("parts for the dispatcher");
    assert_eq!(parts_blind["totals"]["cost"], Value::Null, "costs are for managers");
    let revenue = manager.report("fs_contract_revenue", &[]).await.expect("revenue");
    let c1_row = revenue["rows"].as_array().unwrap().iter().find(|r| r["contract"] == c1_doc["number"]).unwrap().clone();
    assert_eq!(
        (dec(&c1_row["contract_value"]), c1_row["work_orders"].clone(), c1_row["completed"].clone(), dec(&c1_row["revenue"]), dec(&c1_row["margin"])),
        (n("1200"), json!(7), json!(2), n("1200"), n("1200")),
        "four planned visits, a breakdown, the revisited job and the web request; no invoice submitted yet"
    );
    let no_contracts = alice_u.report("fs_contract_revenue", &[]).await;
    assert!(matches!(no_contracts, Err(Error::Forbidden(_))), "{no_contracts:?}");

    // ───────────── undoing a completion returns the parts ─────────────
    let reopened_stock = admin.stock(filter, van_bob).await;
    manager.k.delete(&manager.ctx, "SalesInvoice", uid(&inv2), None).await.expect("drop the warranty invoice");
    manager.k.cancel(&manager.ctx, "ServiceWorkOrder", wo2, None).await.expect("cancel the completion");
    assert_eq!(admin.stock(filter, van_bob).await - reopened_stock, n("1"), "the filter is back in Bob's van");
    assert_eq!(manager.get("ServiceWorkOrder", wo2).await["status"], json!("Cancelled"));
    let redo = manager.k.amend(&manager.ctx, "ServiceWorkOrder", wo2).await.expect("amend");
    assert_eq!((redo["status"].clone(), redo["amended_from"].clone(), redo["docstatus"].clone()), (json!("New"), json!(wo2.to_string()), json!(0)));
    assert_eq!((redo["parts"].as_array().unwrap().len(), redo["labour"].as_array().unwrap().len()), (1, 0), "parts carry over, time is logged again");
    assert_eq!((redo["customer_signature"].clone(), redo["stock_entry"].clone(), redo["sla_status"].clone()), (Value::Null, Value::Null, json!("On Track")));

    // ───────────── the books still balance ─────────────
    let tb = admin.report("trial_balance", &[("company", cid.to_string())]).await.expect("trial balance");
    assert_eq!(tb["meta"]["balanced"], json!(true), "{}", tb["totals"]);
    let sb = admin.report("stock_balance", &[("company", cid.to_string())]).await.expect("stock balance");
    assert_eq!(dec(&sb["totals"]["value"]), admin.gl("Stock In Hand").await, "perpetual inventory: stock value equals the stock account");
}
