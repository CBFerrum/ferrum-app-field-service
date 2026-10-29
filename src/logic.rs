//! Field-service rules without I/O, unit-tested here: travel estimates, working hours in a time
//! zone (DST included), billable labour time, SLA verdicts, contract visit dates and the
//! explainable technician ranking.

use chrono::{DateTime, Datelike, Duration, Months, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::{Decimal, RoundingStrategy};

pub type Ts = DateTime<Utc>;

pub const WEEKDAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/// Priorities, most urgent first (the dispatch board's order).
pub const PRIORITIES: [&str; 4] = ["Urgent", "High", "Medium", "Low"];

// ───────────────────────────── travel ─────────────────────────────

const EARTH_RADIUS_KM: f64 = 6371.0088;

/// Great-circle (haversine) distance in km between two `(latitude, longitude)` points in degrees.
pub fn haversine_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (a.0.to_radians(), a.1.to_radians(), b.0.to_radians(), b.1.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * h.sqrt().min(1.0).asin()
}

/// Straight-line distance (km, 2 decimals) and travel time (minutes, rounded up) at the average
/// speed. Speed is the calibration knob: it absorbs road detours and traffic.
pub fn travel(from: (Decimal, Decimal), to: (Decimal, Decimal), speed_kmh: Decimal) -> (Decimal, i64) {
    let f = |p: (Decimal, Decimal)| (p.0.to_f64().unwrap_or_default(), p.1.to_f64().unwrap_or_default());
    let km = Decimal::from_f64(haversine_km(f(from), f(to))).unwrap_or_default().round_dp(2);
    let speed = if speed_kmh > Decimal::ZERO { speed_kmh } else { Decimal::from(40) };
    let minutes = (km * Decimal::from(60) / speed).ceil().to_i64().unwrap_or(i64::MAX);
    (km, minutes)
}

// ───────────────────────────── working hours ─────────────────────────────

/// "HH:MM" (one-digit hours allowed) → minutes since midnight; "24:00" is the end of the day.
pub fn parse_hm(v: &str) -> Option<u32> {
    let (h, m) = v.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (m < 60 && (h < 24 || (h == 24 && m == 0))).then_some(h * 60 + m)
}

/// A weekly working window in local time: weekday 0 = Monday, minutes since midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub weekday: u32,
    pub start: u32,
    pub end: u32,
}

/// The zone named `name`, else `fallback`, else UTC.
pub fn zone(name: Option<&str>, fallback: &str) -> Tz {
    name.and_then(|n| n.trim().parse::<Tz>().ok()).or_else(|| fallback.parse::<Tz>().ok()).unwrap_or(Tz::UTC)
}

/// The instant `minutes` after local midnight of `day`. A wall time skipped by a DST change
/// moves forward by the gap (it is the same instant); a repeated one takes its first occurrence.
pub fn local_instant(tz: Tz, day: NaiveDate, minutes: u32) -> Ts {
    let wall = day.and_time(NaiveTime::MIN) + Duration::minutes(minutes.into());
    (0..=3).find_map(|gap| tz.from_local_datetime(&(wall + Duration::hours(gap))).earliest()).map_or_else(|| wall.and_utc(), |t| t.with_timezone(&Utc))
}

/// The windows of one local date as UTC instants.
pub fn windows_on(tz: Tz, day: NaiveDate, windows: &[Window]) -> Vec<(Ts, Ts)> {
    let weekday = day.weekday().num_days_from_monday();
    windows.iter().filter(|w| w.weekday == weekday && w.end > w.start).map(|w| (local_instant(tz, day, w.start), local_instant(tz, day, w.end))).collect()
}

/// Working time overlapping `[from, to)`, with touching windows merged (a night shift written as
/// 22:00-24:00 and 00:00-06:00 is one stretch).
pub fn working_intervals(tz: Tz, windows: &[Window], from: Ts, to: Ts) -> Vec<(Ts, Ts)> {
    let (first, last) = (from.with_timezone(&tz).date_naive() - Duration::days(1), to.with_timezone(&tz).date_naive());
    let mut all: Vec<(Ts, Ts)> = first.iter_days().take_while(|d| *d <= last).flat_map(|d| windows_on(tz, d, windows)).collect();
    all.sort();
    let mut merged: Vec<(Ts, Ts)> = Vec::new();
    for (a, z) in all {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(z),
            _ => merged.push((a, z)),
        }
    }
    merged.retain(|(a, z)| *z > from && *a < to);
    merged
}

/// Whether `[start, end)` lies inside working time; without windows every time is working time.
pub fn within_hours(tz: Tz, windows: &[Window], start: Ts, end: Ts) -> bool {
    windows.is_empty() || working_intervals(tz, windows, start, end).iter().any(|(a, z)| *a <= start && *z >= end)
}

fn hours_of(seconds: i64) -> Decimal {
    (Decimal::from(seconds) / Decimal::from(3600)).round_dp(2)
}

/// Working hours over the local dates `from..=to` (`None` without windows: no limit is known).
pub fn available_hours(tz: Tz, windows: &[Window], from: NaiveDate, to: NaiveDate) -> Option<Decimal> {
    if windows.is_empty() {
        return None;
    }
    let (start, end) = (local_instant(tz, from, 0), local_instant(tz, to + Duration::days(1), 0));
    Some(hours_of(working_intervals(tz, windows, start, end).iter().map(|(a, z)| ((*z).min(end) - (*a).max(start)).num_seconds()).sum()))
}

// ───────────────────────────── labour ─────────────────────────────

/// Billable hours of `[from, to)`: started minutes count, rounded up to the billing step, in
/// hours to 2 decimals (the quantity invoiced, so invoice lines recompute exactly).
pub fn labour_hours(from: Ts, to: Ts, step_minutes: i64) -> Decimal {
    let minutes = ((to - from).num_seconds().max(0) + 59) / 60;
    let step = step_minutes.max(1);
    let billed = (minutes + step - 1) / step * step;
    (Decimal::from(billed) / Decimal::from(60)).round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

// ───────────────────────────── service levels ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub response_due: Ts,
    pub resolution_due: Ts,
    pub response_breached: bool,
    pub resolution_breached: bool,
    /// On Track, At Risk, Breached or Met.
    pub status: &'static str,
}

fn after(start: Ts, hours: Decimal) -> Ts {
    let ms = (hours * Decimal::from(3_600_000)).round().to_i64().unwrap_or(i64::MAX / 4);
    start + Duration::milliseconds(ms.min(i64::MAX / 4))
}

/// Deadlines run from `start` in calendar hours. A target is met when its event (arrival on site,
/// completion) happened by its deadline and breached when it happened later or is still pending
/// past it at `now`. A pending deadline with less than a quarter of its window left is At Risk.
pub fn sla_verdict(start: Ts, response_h: Decimal, resolution_h: Decimal, responded: Option<Ts>, resolved: Option<Ts>, now: Ts) -> Verdict {
    let (response_due, resolution_due) = (after(start, response_h), after(start, resolution_h));
    let breached = |due: Ts, done: Option<Ts>| done.map_or(now > due, |t| t > due);
    let (response_breached, resolution_breached) = (breached(response_due, responded), breached(resolution_due, resolved));
    let status = if response_breached || resolution_breached {
        "Breached"
    } else if resolved.is_some() {
        "Met"
    } else {
        let due = if responded.is_none() { response_due } else { resolution_due };
        if (due - now) * 4 < due - start { "At Risk" } else { "On Track" }
    };
    Verdict { response_due, resolution_due, response_breached, resolution_breached, status }
}

// ───────────────────────────── contracts ─────────────────────────────

/// Visit `k` (0 = the first) of a maintenance plan, counted from the first visit so month ends
/// never drift (31 Jan → 28 Feb → 31 Mar).
pub fn visit_date(first: NaiveDate, frequency: &str, every: u32, k: u32) -> Option<NaiveDate> {
    let n = every.max(1).checked_mul(k)?;
    match frequency {
        "Days" => first.checked_add_signed(Duration::days(n.into())),
        "Weeks" => first.checked_add_signed(Duration::weeks(n.into())),
        "Months" => first.checked_add_months(Months::new(n)),
        "Years" => first.checked_add_months(Months::new(n.checked_mul(12)?)),
        _ => None,
    }
}

// ───────────────────────────── technician ranking ─────────────────────────────

/// What is known about one technician for one slot of one work order.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// Required skills the technician lacks.
    pub missing_skills: Vec<String>,
    /// A conflicting active appointment ("FSA-2026-000012 10:00-12:00").
    pub busy_with: Option<String>,
    /// `None` when the work order has no territory.
    pub same_territory: Option<bool>,
    pub territory_name: Option<String>,
    pub within_hours: bool,
    /// (km, minutes, origin) from the previous job that day or home; `None` without coordinates.
    pub travel: Option<(Decimal, i64, String)>,
    /// Minutes the technician would arrive late after the previous job.
    pub late_minutes: i64,
    /// Other active jobs that local day.
    pub jobs_that_day: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub eligible: bool,
    /// 0-100: territory 30, working hours 20, travel 40 (none after 2 hours), workload 10,
    /// minus 20 when the technician cannot make it in time.
    pub score: i64,
    pub reasons: Vec<String>,
}

pub fn assess(f: &Facts) -> Assessment {
    let mut reasons = Vec::new();
    let mut eligible = true;
    if !f.missing_skills.is_empty() {
        eligible = false;
        reasons.push(format!("missing skills: {}", f.missing_skills.join(", ")));
    }
    if let Some(b) = &f.busy_with {
        eligible = false;
        reasons.push(format!("already booked: {b}"));
    }
    let mut score = match f.same_territory {
        Some(true) => {
            reasons.push("works in the work order's territory".into());
            30
        }
        Some(false) => {
            reasons.push(format!("works in another territory ({})", f.territory_name.as_deref().unwrap_or("none")));
            0
        }
        None => 15,
    };
    if f.within_hours {
        reasons.push("within working hours".into());
        score += 20;
    } else {
        reasons.push("outside working hours (overtime)".into());
    }
    match &f.travel {
        Some((km, minutes, origin)) => {
            reasons.push(format!("{} km from {origin}, about {minutes} min", km.normalize()));
            score += (40 * (120 - (*minutes).clamp(0, 120)) + 60) / 120;
        }
        None => {
            reasons.push("no coordinates to estimate travel".into());
            score += 20;
        }
    }
    if f.late_minutes > 0 {
        reasons.push(format!("would arrive about {} min late after the previous job", f.late_minutes));
        score -= 20;
    }
    score += (10 - 3 * f.jobs_that_day).max(0);
    if f.jobs_that_day > 0 {
        reasons.push(format!("{} other job(s) that day", f.jobs_that_day));
    }
    Assessment { eligible, score: score.clamp(0, 100), reasons }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn n(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn t(s: &str) -> Ts {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn haversine_and_travel() {
        // A tenth of a degree of latitude is 11.12 km anywhere.
        assert_eq!(travel((n("51.5"), n("-0.12")), (n("51.6"), n("-0.12")), n("40")), (n("11.12"), 17));
        assert_eq!(travel((n("51.5"), n("-0.12")), (n("51.5"), n("-0.12")), n("40")), (n("0"), 0));
        // London to Paris, about 343.5 km.
        let km = haversine_km((51.5074, -0.1278), (48.8566, 2.3522));
        assert!((343.0..344.0).contains(&km), "{km}");
        assert_eq!(travel((n("51.5074"), n("-0.1278")), (n("48.8566"), n("2.3522")), n("80")).1, 258);
    }

    #[test]
    fn working_hours_follow_the_zone_across_dst() {
        let london: Tz = "Europe/London".parse().unwrap();
        let week: Vec<Window> = (0..7).map(|d| Window { weekday: d, start: 9 * 60, end: 17 * 60 }).collect();
        // Saturday 24 Oct 2026 is still summer time (UTC+1); Sunday 25 Oct is GMT again.
        assert_eq!(windows_on(london, day("2026-10-24"), &week), vec![(t("2026-10-24T08:00:00Z"), t("2026-10-24T16:00:00Z"))]);
        assert_eq!(windows_on(london, day("2026-10-25"), &week), vec![(t("2026-10-25T09:00:00Z"), t("2026-10-25T17:00:00Z"))]);
        assert_eq!(available_hours(london, &week, day("2026-10-24"), day("2026-10-25")), Some(n("16")));
        // A full day is 25 hours long when the clocks go back, and 23 when they go forward.
        let always: Vec<Window> = (0..7).map(|d| Window { weekday: d, start: 0, end: 24 * 60 }).collect();
        assert_eq!(available_hours(london, &always, day("2026-10-25"), day("2026-10-25")), Some(n("25")));
        assert_eq!(available_hours(london, &always, day("2026-03-29"), day("2026-03-29")), Some(n("23")));
        // 01:30 does not exist on 29 March in London: it is the instant 02:30 summer time would be.
        assert_eq!(local_instant(london, day("2026-03-29"), 90), t("2026-03-29T01:30:00Z"));
        // 01:30 happens twice on 25 October: the first (summer time) is taken.
        assert_eq!(local_instant(london, day("2026-10-25"), 90), t("2026-10-25T00:30:00Z"));
        assert!(within_hours(london, &week, t("2026-10-24T08:00:00Z"), t("2026-10-24T10:00:00Z")));
        assert!(!within_hours(london, &week, t("2026-10-25T08:00:00Z"), t("2026-10-25T10:00:00Z")), "08:00 GMT is before nine");
        assert!(within_hours(london, &[], t("2026-10-25T02:00:00Z"), t("2026-10-25T03:00:00Z")), "no windows: round the clock");
        assert_eq!(available_hours(london, &[], day("2026-10-25"), day("2026-10-25")), None);
    }

    #[test]
    fn night_shifts_merge_across_midnight() {
        let utc: Tz = "UTC".parse().unwrap();
        // Monday 22:00-24:00 and Tuesday 00:00-06:00 are one shift.
        let night = [Window { weekday: 0, start: 22 * 60, end: 24 * 60 }, Window { weekday: 1, start: 0, end: 6 * 60 }];
        assert!(within_hours(utc, &night, t("2026-11-02T23:00:00Z"), t("2026-11-03T02:00:00Z")));
        assert!(!within_hours(utc, &night, t("2026-11-03T05:00:00Z"), t("2026-11-03T07:00:00Z")));
        assert_eq!(zone(Some("Not/AZone"), "Asia/Kolkata"), Tz::Asia__Kolkata);
        assert_eq!(zone(None, "nonsense"), Tz::UTC);
        for bad in ["24:01", "25:00", "09:60", "0900", "9", ":30"] {
            assert_eq!(parse_hm(bad), None, "{bad}");
        }
        assert_eq!((parse_hm("9:30"), parse_hm("24:00")), (Some(570), Some(1440)));
    }

    #[test]
    fn labour_is_billed_in_started_steps() {
        let s = t("2026-11-02T09:00:00Z");
        assert_eq!(labour_hours(s, s + Duration::minutes(90), 1), n("1.5"));
        assert_eq!(labour_hours(s, s + Duration::minutes(20), 1), n("0.33"));
        assert_eq!(labour_hours(s, s + Duration::minutes(20), 15), n("0.5"));
        assert_eq!(labour_hours(s, s + Duration::minutes(61), 15), n("1.25"));
        assert_eq!(labour_hours(s, s + Duration::seconds(61), 1), n("0.03"), "a started minute counts");
        assert_eq!(labour_hours(s, s - Duration::minutes(5), 1), n("0"));
    }

    #[test]
    fn service_level_verdicts() {
        let start = t("2026-11-02T08:00:00Z");
        let (r, z) = (n("4"), n("24"));
        let v = sla_verdict(start, r, z, None, None, t("2026-11-02T09:00:00Z"));
        assert_eq!((v.response_due, v.resolution_due, v.status), (t("2026-11-02T12:00:00Z"), t("2026-11-03T08:00:00Z"), "On Track"));
        assert_eq!(sla_verdict(start, r, z, None, None, t("2026-11-02T11:30:00Z")).status, "At Risk", "half an hour of four left");
        let late = sla_verdict(start, r, z, None, None, t("2026-11-02T12:00:01Z"));
        assert!(late.response_breached && !late.resolution_breached && late.status == "Breached");
        let arrived = Some(t("2026-11-02T11:00:00Z"));
        assert_eq!(sla_verdict(start, r, z, arrived, None, t("2026-11-02T13:00:00Z")).status, "On Track", "now the resolution clock counts");
        let met = sla_verdict(start, r, z, arrived, Some(t("2026-11-02T15:00:00Z")), t("2026-11-09T00:00:00Z"));
        assert_eq!((met.response_breached, met.resolution_breached, met.status), (false, false, "Met"), "done in time stays met");
        let slow = sla_verdict(start, r, z, Some(t("2026-11-02T12:30:00Z")), Some(t("2026-11-02T15:00:00Z")), t("2026-11-09T00:00:00Z"));
        assert_eq!((slow.response_breached, slow.status), (true, "Breached"));
        assert_eq!(sla_verdict(start, n("1.5"), z, None, None, start).response_due, t("2026-11-02T09:30:00Z"));
    }

    #[test]
    fn visit_dates_do_not_drift() {
        let dates = |first: &str, f: &str, every: u32| (0..4).map(|k| visit_date(day(first), f, every, k).unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(dates("2026-01-31", "Months", 1), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
        assert_eq!(dates("2026-01-01", "Months", 3), ["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
        assert_eq!(dates("2024-02-29", "Years", 1), ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28"]);
        assert_eq!(dates("2026-11-02", "Weeks", 2), ["2026-11-02", "2026-11-16", "2026-11-30", "2026-12-14"]);
        assert_eq!(dates("2026-11-02", "Days", 10), ["2026-11-02", "2026-11-12", "2026-11-22", "2026-12-02"]);
        assert_eq!(visit_date(day("2026-01-01"), "Hourly", 1, 1), None);
    }

    #[test]
    fn ranking_explains_itself() {
        let near = Facts { same_territory: Some(true), within_hours: true, travel: Some((n("5.5"), 9, "home".into())), ..Default::default() };
        let a = assess(&near);
        assert!(a.eligible);
        assert_eq!(a.score, 30 + 20 + 37 + 10);
        assert_eq!(a.reasons, ["works in the work order's territory", "within working hours", "5.5 km from home, about 9 min"]);
        let far = Facts { travel: Some((n("90"), 135, "home".into())), jobs_that_day: 2, late_minutes: 15, ..near.clone() };
        let b = assess(&far);
        assert_eq!(b.score, 30 + 20 + 4 - 20);
        assert!(b.reasons.contains(&"would arrive about 15 min late after the previous job".to_string()));
        let unskilled = Facts { missing_skills: vec!["HVAC".into()], busy_with: Some("FSA-1 10:00-12:00".into()), ..near };
        let c = assess(&unskilled);
        assert!(!c.eligible);
        assert_eq!(&c.reasons[..2], ["missing skills: HVAC", "already booked: FSA-1 10:00-12:00"]);
        let unknown = assess(&Facts::default());
        assert_eq!(unknown.score, 15 + 20 + 10);
    }
}
