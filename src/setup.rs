//! Setup records: the settings (read once per operation into [`Settings`]), technicians and the
//! installed base.

use crate::logic::{self, Window};
use async_trait::async_trait;
use chrono_tz::Tz;
use ferrum_domain::util::{d, id, rows, s, set, sys};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, FieldError, HookCtx, Kernel, Result, Tx};
use rust_decimal::Decimal;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Field Service Settings with their defaults (also when no settings record exists yet).
#[derive(Debug, Clone)]
pub struct Settings {
    pub labour_item: Option<Uuid>,
    pub expense_item: Option<Uuid>,
    pub labour_step: i64,
    pub speed_kmh: Decimal,
    pub default_duration: i64,
    pub default_warehouse: Option<Uuid>,
    pub require_checklist: bool,
    pub require_signature: bool,
    pub auto_invoice: bool,
    pub notify_customer: bool,
    pub public_requests: bool,
    pub tracking_days: i64,
    /// priority → (response hours, resolution hours)
    pub sla: HashMap<String, (Decimal, Decimal)>,
    pub default_hours: Vec<Window>,
}

impl Settings {
    pub async fn load(k: &Kernel, ctx: &Ctx, tx: &mut Tx) -> Result<Settings> {
        let sctx = sys(ctx);
        let found = k.find_tx(&sctx, tx, "FieldServiceSettings", &[], None, 1).await?;
        let doc = match found.first().and_then(|f| id(f, "id")) {
            Some(sid) => k.get_tx(&sctx, tx, "FieldServiceSettings", sid, false).await?,
            None => Doc::new(),
        };
        Ok(Settings::from_doc(&doc))
    }

    fn from_doc(doc: &Doc) -> Settings {
        let flag = |k: &str, default: bool| doc.get(k).and_then(Value::as_bool).unwrap_or(default);
        let int = |k: &str, default: i64| doc.get(k).and_then(Value::as_i64).filter(|v| *v > 0).unwrap_or(default);
        let speed = d(doc, "travel_speed_kmh");
        Settings {
            labour_item: id(doc, "labour_item"),
            expense_item: id(doc, "expense_item"),
            labour_step: int("labour_increment_minutes", 1),
            speed_kmh: if speed > Decimal::ZERO { speed } else { Decimal::from(40) },
            default_duration: int("default_duration_minutes", 60),
            default_warehouse: id(doc, "default_warehouse"),
            require_checklist: flag("require_checklist", true),
            require_signature: flag("require_signature", true),
            auto_invoice: flag("auto_invoice", false),
            notify_customer: flag("notify_customer", true),
            public_requests: flag("public_requests", false),
            tracking_days: int("tracking_link_days", 30),
            sla: rows(doc, "sla_targets")
                .iter()
                .filter_map(|r| Some((s(r, "priority")?.to_string(), (d(r, "response_hours"), d(r, "resolution_hours")))))
                .collect(),
            default_hours: windows(doc, "default_working_hours"),
        }
    }
}

/// One `ServiceWorkingHour` row as a window (invalid rows are refused on save).
pub fn window(weekday: Option<&str>, start: Option<&str>, end: Option<&str>) -> Option<Window> {
    let weekday = logic::WEEKDAYS.iter().position(|w| Some(*w) == weekday)? as u32;
    Some(Window { weekday, start: logic::parse_hm(start?)?, end: logic::parse_hm(end?)? })
}

/// The working windows of a `ServiceWorkingHour` table.
pub fn windows(doc: &Doc, table: &str) -> Vec<Window> {
    rows(doc, table).iter().filter_map(|r| window(s(r, "weekday"), s(r, "start_time"), s(r, "end_time"))).collect()
}

fn check_hours(doc: &Doc, table: &str, errors: &mut Vec<FieldError>) {
    for (i, r) in rows(doc, table).iter().enumerate() {
        match (s(r, "start_time").map(logic::parse_hm), s(r, "end_time").map(logic::parse_hm)) {
            (Some(None), _) => errors.push(FieldError::new("start_time", "use HH:MM, e.g. 08:30").in_row(table, i)),
            (_, Some(None)) => errors.push(FieldError::new("end_time", "use HH:MM, e.g. 17:00 (24:00 for midnight)").in_row(table, i)),
            (Some(Some(a)), Some(Some(z))) if a >= z => {
                errors.push(FieldError::new("end_time", "must be after the start time; enter a night shift as one row per day").in_row(table, i))
            }
            _ => {}
        }
    }
}

fn done(errors: Vec<FieldError>) -> Result<()> {
    if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
}

pub struct SettingsHook;

#[async_trait]
impl DocHook for SettingsHook {
    async fn validate(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        let mut seen = HashSet::new();
        for (i, r) in rows(doc, "sla_targets").iter().enumerate() {
            if let Some(p) = s(r, "priority")
                && !seen.insert(p.to_string())
            {
                errors.push(FieldError::new("priority", "is listed twice").in_row("sla_targets", i));
            }
        }
        check_hours(doc, "default_working_hours", &mut errors);
        done(errors)
    }
}

pub struct TechnicianHook;

#[async_trait]
impl DocHook for TechnicianHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        check_hours(doc, "working_hours", &mut errors);
        if let Some(zone) = s(doc, "time_zone")
            && zone.trim().parse::<Tz>().is_err()
        {
            errors.push(FieldError::new("time_zone", "is not an IANA time zone name, e.g. Europe/London or Asia/Kolkata"));
        }
        let mut seen = HashSet::new();
        for (i, r) in rows(doc, "skills").iter().enumerate() {
            if let Some(skill) = id(r, "skill")
                && !seen.insert(skill)
            {
                errors.push(FieldError::new("skill", "is listed twice").in_row("skills", i));
            }
        }
        if has(doc, "home_latitude") != has(doc, "home_longitude") {
            errors.push(FieldError::new("home_longitude", "give both the latitude and the longitude of the home location"));
        }
        if let Some(email) = s(doc, "user_email") {
            let known: bool = sqlx::query_scalar("select exists (select 1 from app_user where tenant_id = $1 and lower(email::text) = lower($2))")
                .bind(hc.ctx.tenant)
                .bind(email)
                .fetch_one(&mut **hc.tx)
                .await?;
            if !known {
                errors.push(FieldError::new("user_email", "no user signs in with this email; invite the technician as a user first"));
            }
        }
        done(errors)
    }
}

pub struct EquipmentHook;

#[async_trait]
impl DocHook for EquipmentHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let name = match (s(doc, "item_name"), s(doc, "serial_no")) {
            (Some(item), Some(serial)) => format!("{item} ({serial})"),
            (Some(item), None) => item.to_string(),
            (None, Some(serial)) => serial.to_string(),
            (None, None) => String::new(),
        };
        set(doc, "equipment_name", name);
        Ok(())
    }

    async fn validate(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        coordinates(doc)
    }
}

/// Whether a field holds a value.
pub fn has(doc: &Doc, key: &str) -> bool {
    doc.get(key).is_some_and(|v| !v.is_null())
}

/// A site's latitude and longitude come together or not at all.
pub fn coordinates(doc: &Doc) -> Result<()> {
    if has(doc, "latitude") != has(doc, "longitude") {
        return Err(Error::field("longitude", "give both the latitude and the longitude of the site"));
    }
    Ok(())
}

/// A site's `(latitude, longitude)`, when both are known.
pub fn point(doc: &Doc, lat: &str, lng: &str) -> Option<(Decimal, Decimal)> {
    (has(doc, lat) && has(doc, lng)).then(|| (d(doc, lat), d(doc, lng)))
}
