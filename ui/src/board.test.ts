import { describe, expect, it } from "vitest";
import {
  axisFor,
  type Board,
  bookedHours,
  candidateSlots,
  type Job,
  type Lane,
  lengthOf,
  load,
  neighbour,
  offHours,
  place,
  queueFilter,
  resized,
  skillsAsked,
  slotAt,
  undispatched,
  type Visit,
  weekOf,
  workday,
  withJobScheduled,
  withVisitMoved,
  withVisitStatus,
} from "./board";
import { instantOf } from "./time";

const t = (hhmm: string, day = "2026-11-02") => `${day}T${hhmm}:00.000Z`;
const ms = (iso: string) => Date.parse(iso);

const visit = (n: string, from: string, to: string, extra: Partial<Visit> = {}): Visit => ({
  appointment: `a${n}`,
  number: `FSA-${n}`,
  status: "Scheduled",
  start: t(from),
  end: t(to),
  actual_start: null,
  actual_end: null,
  work_order: `w${n}`,
  work_order_number: `FSWO-${n}`,
  customer_name: `Customer ${n}`,
  priority: "Medium",
  site: null,
  travel: null,
  ...extra,
});

const lane = (id: string, appointments: Visit[], extra: Partial<Lane> = {}): Lane => ({
  technician: id,
  technician_name: `Tech ${id}`,
  user_email: `${id}@x.test`,
  territory: null,
  territory_name: null,
  time_zone: "UTC",
  home: null,
  working_hours: [{ start: t("09:00"), end: t("17:00") }],
  available_hours: "8",
  booked_hours: "0",
  appointments,
  ...extra,
});

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  work_order: id,
  number: `FSWO-${id}`,
  customer_name: `Customer ${id}`,
  priority: "Medium",
  work_type: "Repair",
  reported_at: null,
  response_due: null,
  resolution_due: null,
  sla_status: null,
  response_breached: false,
  territory: null,
  territory_name: null,
  site: null,
  estimated_duration_minutes: 90,
  preferred_start: null,
  required_skills: [],
  ...extra,
});

const board = (technicians: Lane[], unscheduled: Job[] = []): Board => ({ from: "2026-11-02", to: "2026-11-02", time_zone: "UTC", travel_speed_kmh: "40", technicians, unscheduled });

describe("the axis of a day", () => {
  it("is seven to seven when nothing asks for more", () => {
    const axis = axisFor("2026-11-02", "UTC", [lane("a", [])]);
    expect([axis.minutes, axis.ticks.length]).toEqual([12 * 60, 13]);
    expect(axis.start).toBe(ms(t("07:00")));
  });

  it("stretches to hold the working hours and visits, with an hour to spare", () => {
    const axis = axisFor("2026-11-02", "UTC", [lane("a", [visit("1", "05:30", "06:30")], { working_hours: [{ start: t("05:00"), end: t("21:00") }] })]);
    expect([axis.start, axis.end]).toEqual([ms(t("04:00")), ms(t("22:00"))]);
  });

  it("keeps within the day", () => {
    const axis = axisFor("2026-11-02", "UTC", [lane("a", [], { working_hours: [{ start: t("00:00"), end: t("23:59") }] })]);
    expect([axis.start, axis.end]).toEqual([ms(t("00:00")), ms(t("00:00", "2026-11-03"))]);
  });

  it("follows the zone: nine in Kolkata is half past three in UTC", () => {
    const axis = axisFor("2026-11-02", "Asia/Kolkata", []);
    expect(axis.start).toBe(instantOf("2026-11-02", 7 * 60, "Asia/Kolkata"));
    expect(new Date(axis.start).toISOString()).toBe("2026-11-02T01:30:00.000Z");
  });

  it("is a day an hour longer when the clocks go back", () => {
    const axis = axisFor("2026-10-25", "Europe/London", [lane("a", [], { working_hours: [{ start: "2026-10-25T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" }] })]);
    expect(axis.minutes).toBe(25 * 60);
  });
});

describe("a lane", () => {
  const axis = axisFor("2026-11-02", "UTC", []);

  it("places visits on the axis in minutes", () => {
    const { items, rows } = place(lane("a", [visit("2", "13:00", "14:30"), visit("1", "09:00", "10:00")]), axis);
    expect(items.map((i) => [i.visit.number, i.from, i.to, i.row])).toEqual([
      ["FSA-1", 120, 180, 0],
      ["FSA-2", 360, 450, 0],
    ]);
    expect(rows).toBe(1);
  });

  it("stacks visits that overlap, so a finished one does not hide the next", () => {
    const { items, rows } = place(lane("a", [visit("1", "09:00", "11:00", { status: "Cannot Complete" }), visit("2", "10:00", "12:00")]), axis);
    expect(items.map((i) => i.row)).toEqual([0, 1]);
    expect(rows).toBe(2);
  });

  it("cuts a visit at the edge of the axis and says so", () => {
    const { items } = place(lane("a", [visit("1", "06:00", "08:00")]), axis);
    expect(items[0]).toMatchObject({ from: 0, to: 60, cutStart: true, cutEnd: false });
    expect(place(lane("a", [visit("2", "05:00", "06:00")]), axis).items).toEqual([]);
  });

  it("draws the drive to a visit and flags one that does not fit between the jobs", () => {
    const first = visit("1", "09:00", "10:00");
    const tight = visit("2", "10:20", "11:00", { travel: { from: "FSA-1", km: "12", minutes: 35 } });
    const roomy = visit("3", "13:00", "14:00", { travel: { from: "FSA-2", km: "5", minutes: 30 } });
    const { items } = place(lane("a", [first, tight, roomy]), axis);
    expect(items[1].travel).toMatchObject({ from: 165, to: 200, minutes: 35 });
    expect(items.map((i) => i.late)).toEqual([0, 15, 0]);
  });

  it("does not hold a technician to the clock for the drive from home", () => {
    const { items } = place(lane("a", [visit("1", "07:10", "08:00", { travel: { from: "home", km: "30", minutes: 45 } })]), axis);
    expect(items[0]).toMatchObject({ late: 0, travel: { from: 0, to: 10 } });
  });

  it("shades what is outside working hours, and all of a day off", () => {
    expect(offHours(lane("a", []), axis)).toEqual([
      { from: 0, to: 120 },
      { from: 600, to: 720 },
    ]);
    expect(offHours(lane("a", [], { working_hours: [], available_hours: "0" }), axis)).toEqual([{ from: 0, to: 720 }]);
    expect(offHours(lane("a", [], { working_hours: [], available_hours: null }), axis)).toEqual([]);
    expect(offHours(lane("a", [], { working_hours: [{ start: t("09:00"), end: t("12:00") }, { start: t("11:00"), end: t("17:00") }] }), axis)).toHaveLength(2);
  });

  it("counts booked hours as the server does: busy visits only, within the range", () => {
    const visits = [visit("1", "09:00", "10:30"), visit("2", "11:00", "12:00", { status: "Completed" }), visit("3", "16:00", "18:00")];
    expect(bookedHours(visits, ms(t("00:00")), ms(t("00:00", "2026-11-03")))).toBe(3.5);
    expect(bookedHours(visits, ms(t("17:00")), ms(t("23:00")))).toBe(1);
  });

  it("says how full the day is", () => {
    expect(load({ booked_hours: "5.5", available_hours: "8" })).toMatchObject({ text: "5.5 of 8 h", over: false, ratio: 5.5 / 8 });
    expect(load({ booked_hours: "9", available_hours: "8" })).toMatchObject({ over: true, ratio: 1 });
    expect(load({ booked_hours: "0", available_hours: "0" }).text).toBe("Not working");
    expect(load({ booked_hours: "2", available_hours: null }).text).toBe("2 h booked");
    expect(load({ booked_hours: "0", available_hours: null }).text).toBe("Free");
  });
});

describe("drops and resizes", () => {
  const axis = axisFor("2026-11-02", "UTC", []);

  it("lets a visit go on the quarter hour nearest where it was dropped", () => {
    const slot = slotAt(axis, 127, 90);
    expect([slot.start, slot.end]).toEqual([ms(t("09:00")), ms(t("10:30"))]);
    expect(slotAt(axis, 127 + 10, 60, 10).start).toBe(ms(t("09:00")));
  });

  it("keeps a drop on the axis", () => {
    expect(slotAt(axis, -50, 60).start).toBe(axis.start);
    expect(slotAt(axis, 5000, 60).start).toBe(axis.end - 15 * 60_000);
  });

  it("resizes by an edge, never below a quarter hour", () => {
    const slot = { start: ms(t("09:00")), end: ms(t("10:00")) };
    expect(resized(slot, "end", 31)).toEqual({ start: slot.start, end: ms(t("10:30")) });
    expect(resized(slot, "start", -29).start).toBe(ms(t("08:30")));
    expect(resized(slot, "end", -600).end).toBe(slot.start + 15 * 60_000);
    expect(resized(slot, "start", 600).start).toBe(slot.end - 15 * 60_000);
  });

  it("plans a job for the time it says, else an hour", () => {
    expect(lengthOf({ estimated_duration_minutes: 45 })).toBe(45);
    expect(lengthOf({ estimated_duration_minutes: null })).toBe(60);
    expect(lengthOf({ estimated_duration_minutes: 0 })).toBe(60);
  });
});

describe("the board once a move is accepted", () => {
  it("takes a queued job into a lane", () => {
    const b = board([lane("a", [])], [job("9"), job("8")]);
    const next = withJobScheduled(b, "9", "a", ms(t("09:00")), ms(t("10:30")));
    expect(next.unscheduled.map((j) => j.work_order)).toEqual(["8"]);
    expect(next.technicians[0].appointments).toHaveLength(1);
    expect(next.technicians[0].appointments[0]).toMatchObject({ status: "Scheduled", work_order: "9", work_order_number: "FSWO-9" });
    expect(next.technicians[0].booked_hours).toBe("1.5");
    expect(b.unscheduled).toHaveLength(2);
  });

  it("moves a visit to another technician and time, and counts both days again", () => {
    const b = board([lane("a", [visit("1", "09:00", "11:00")], { booked_hours: "2" }), lane("b", [])]);
    const next = withVisitMoved(b, "a1", { technician: "b", from: "a", start: ms(t("13:00")), end: ms(t("14:00")) });
    expect(next.technicians[0].appointments).toEqual([]);
    expect(next.technicians[1].appointments[0]).toMatchObject({ appointment: "a1", start: t("13:00") });
    expect([next.technicians[0].booked_hours, next.technicians[1].booked_hours]).toEqual(["0", "1"]);
  });

  it("adds a second technician when asked, and moves the whole crew's blocks together", () => {
    const crew = [lane("a", [visit("1", "09:00", "10:00")]), lane("b", [visit("1", "09:00", "10:00")]), lane("c", [])];
    const next = withVisitMoved(board(crew), "a1", { technician: "c", from: "a", add: true, start: ms(t("11:00")), end: ms(t("12:00")) });
    expect(next.technicians.map((l) => l.appointments.map((v) => v.start))).toEqual([[t("11:00")], [t("11:00")], [t("11:00")]]);
  });

  it("sends a moved dispatched visit back to scheduled: it has to be dispatched again", () => {
    const b = board([lane("a", [visit("1", "09:00", "10:00", { status: "Dispatched" })])]);
    expect(withVisitMoved(b, "a1", { technician: "a", start: ms(t("10:00")), end: ms(t("11:00")) }).technicians[0].appointments[0].status).toBe("Scheduled");
    const underway = board([lane("a", [visit("1", "09:00", "10:00", { status: "On Site" })])]);
    expect(withVisitMoved(underway, "a1", { technician: "a", start: ms(t("10:00")), end: ms(t("11:00")) }).technicians[0].appointments[0].status).toBe("On Site");
  });

  it("changes a visit's status or takes it off", () => {
    const b = board([lane("a", [visit("1", "09:00", "10:00")])]);
    expect(withVisitStatus(b, "a1", "Dispatched").technicians[0].appointments[0].status).toBe("Dispatched");
    const gone = withVisitStatus(b, "a1", null).technicians[0];
    expect([gone.appointments.length, gone.booked_hours]).toEqual([0, "0"]);
  });

  it("leaves the board alone for a visit it does not know", () => {
    const b = board([lane("a", [])]);
    expect(withVisitMoved(b, "nope", { technician: "a", start: 0, end: 1 })).toBe(b);
    expect(withJobScheduled(b, "nope", "a", 0, 1)).toBe(b);
  });
});

describe("the queue and dispatch", () => {
  const jobs = [job("1", { customer_name: "Acme Boilers", required_skills: ["Gas safe"] }), job("2", { customer_name: "Bright Dental", required_skills: ["HVAC", "Gas safe"] }), job("3", { number: "FSWO-7", work_type: "Inspection" })];

  it("lists the skills the waiting jobs ask for once, in order", () => {
    expect(skillsAsked(jobs)).toEqual(["Gas safe", "HVAC"]);
  });

  it("filters by skill and by what a card shows, keeping the server's order", () => {
    expect(queueFilter(jobs, { skill: "Gas safe" }).map((j) => j.work_order)).toEqual(["1", "2"]);
    expect(queueFilter(jobs, { q: "dental" }).map((j) => j.work_order)).toEqual(["2"]);
    expect(queueFilter(jobs, { q: "fswo-7" }).map((j) => j.work_order)).toEqual(["3"]);
    expect(queueFilter(jobs, { q: "  " })).toHaveLength(3);
    expect(queueFilter(jobs, { skill: "HVAC", q: "acme" })).toEqual([]);
  });

  it("finds the visits still to be dispatched, once per job, soonest first", () => {
    const b = board([
      lane("a", [visit("2", "13:00", "14:00"), visit("1", "09:00", "10:00", { status: "Dispatched" })]),
      lane("b", [visit("2", "13:00", "14:00"), visit("3", "08:00", "09:00")]),
    ]);
    expect(undispatched(b).map((v) => v.appointment)).toEqual(["a3", "a2"]);
  });
});

describe("finding a time for a job", () => {
  const axis = axisFor("2026-11-02", "UTC", []);
  const lanes = [lane("a", []), lane("b", [], { working_hours: [{ start: t("08:00"), end: t("16:00") }] })];

  it("knows the working day from the first start to the last finish", () => {
    expect(workday(lanes, axis)).toEqual({ start: ms(t("08:00")), end: ms(t("17:00")) });
    expect(workday([lane("a", [], { working_hours: [] })], axis)).toEqual({ start: axis.start, end: axis.end });
  });

  it("tries what the customer asked for, then each hour of the day", () => {
    const work = { start: ms(t("09:00")), end: ms(t("13:00")) };
    const slots = candidateSlots({ estimated_duration_minutes: 90, preferred_start: t("10:30") }, work, ms(t("06:00")));
    expect(slots.map((s) => s.start)).toEqual([ms(t("10:30")), ms(t("09:00")), ms(t("10:00")), ms(t("11:00"))]);
    expect(slots[0].end).toBe(ms(t("12:00")));
  });

  it("never offers a time that has gone, or one that runs past the day", () => {
    const work = { start: ms(t("09:00")), end: ms(t("13:00")) };
    const slots = candidateSlots({ estimated_duration_minutes: 60, preferred_start: t("09:00") }, work, ms(t("10:05")));
    expect(slots.map((s) => s.start)).toEqual([ms(t("10:15")), ms(t("11:15"))]);
    expect(candidateSlots({ estimated_duration_minutes: 60, preferred_start: null }, work, ms(t("12:30")))).toEqual([]);
  });

  it("stops after a handful", () => {
    expect(candidateSlots({ estimated_duration_minutes: 15, preferred_start: null }, { start: ms(t("00:00")), end: ms(t("23:00")) }, 0, 3)).toHaveLength(3);
  });
});

describe("moving between visits with the arrow keys", () => {
  const lanes = [lane("a", [visit("1", "09:00", "10:00"), visit("2", "13:00", "14:00")]), lane("b", []), lane("c", [visit("3", "08:00", "09:00"), visit("4", "12:30", "13:30")])];

  it("goes along a lane and stops at its ends", () => {
    expect(neighbour(lanes, "a1", "ArrowRight")).toBe("a2");
    expect(neighbour(lanes, "a2", "ArrowLeft")).toBe("a1");
    expect(neighbour(lanes, "a1", "ArrowLeft")).toBeNull();
    expect(neighbour(lanes, "a2", "ArrowRight")).toBeNull();
  });

  it("goes to the nearest start in the next lane with any visit", () => {
    expect(neighbour(lanes, "a2", "ArrowDown")).toBe("a4");
    expect(neighbour(lanes, "a1", "ArrowDown")).toBe("a3");
    expect(neighbour(lanes, "a4", "ArrowUp")).toBe("a2");
    expect(neighbour(lanes, "a1", "ArrowUp")).toBeNull();
    expect(neighbour(lanes, "nope", "ArrowDown")).toBeNull();
    expect(neighbour(lanes, "a1", "x")).toBeNull();
  });
});

describe("a week of days", () => {
  const monday = "2026-11-02";
  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
  const work = (day: string) => ({ start: at(day, "09:00"), end: at(day, "17:00") });
  const row = lane("a", [
    visit("1", "09:00", "11:30"),
    visit("2", "13:00", "14:00", { status: "Completed" }),
    { ...visit("3", "09:00", "17:00"), start: at("2026-11-04", "09:00"), end: at("2026-11-04", "18:30") },
  ], { working_hours: [work(monday), work("2026-11-03"), work("2026-11-04")], available_hours: "24" });

  it("counts each day's booked and working hours and its visits, a finished one not at all", () => {
    const { days, rows } = weekOf({ technicians: [row], time_zone: "UTC" }, monday);
    expect(days[0]).toBe("2026-11-02");
    expect(days[6]).toBe("2026-11-08");
    expect(rows[0].cells.map((c) => [c.booked, c.available, c.visits])).toEqual([
      [2.5, 8, 1],
      [0, 8, 0],
      [9.5, 8, 1],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it("says which days are booked past their hours", () => {
    const { rows } = weekOf({ technicians: [row], time_zone: "UTC" }, monday);
    expect(rows[0].cells.map((c) => c.over)).toEqual([false, false, true, false, false, false, false]);
  });

  it("leaves hours open for a technician with none set", () => {
    const { rows } = weekOf({ technicians: [{ ...row, available_hours: null, working_hours: [] }], time_zone: "UTC" }, monday);
    expect(rows[0].cells.every((c) => c.available === null && !c.over)).toBe(true);
  });
});
