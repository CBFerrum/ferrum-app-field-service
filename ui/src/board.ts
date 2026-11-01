// The dispatch board's arithmetic: where visits sit on a day's axis, what is outside a technician's
// hours, which travel does not fit, what a drop on a lane means, and the board as it will be once a
// move is accepted (shown at once, put back if the server refuses). Pure, so it is tested without a
// browser. Positions are minutes from the start of the axis; the screen multiplies by its zoom.

import { addDays, dayOf, daysBetween, HOUR, instantOf, MINUTE, snap, wall } from "./time";

export interface Site {
  latitude: string;
  longitude: string;
}

export interface Travel {
  /** "home", or the number of the appointment the technician comes from. */
  from: string;
  km: string;
  minutes: number;
}

/** One technician's place on one appointment (`GET /api/app/field_service/dispatch`). */
export interface Visit {
  appointment: string;
  number: string;
  status: string;
  start: string;
  end: string;
  actual_start: string | null;
  actual_end: string | null;
  work_order: string;
  work_order_number: string;
  customer_name: string;
  priority: string | null;
  site: Site | null;
  travel: Travel | null;
}

export interface Lane {
  technician: string;
  technician_name: string;
  user_email: string | null;
  territory: string | null;
  territory_name: string | null;
  time_zone: string;
  home: Site | null;
  working_hours: { start: string; end: string }[];
  /** Null: no working hours are set, so the technician is on call round the clock. */
  available_hours: string | null;
  booked_hours: string;
  appointments: Visit[];
}

/** A work order waiting to be scheduled. */
export interface Job {
  work_order: string;
  number: string;
  customer_name: string;
  priority: string | null;
  work_type: string | null;
  reported_at: string | null;
  response_due: string | null;
  resolution_due: string | null;
  sla_status: string | null;
  response_breached: boolean;
  territory: string | null;
  territory_name: string | null;
  site: Site | null;
  estimated_duration_minutes: number | null;
  preferred_start: string | null;
  required_skills: string[];
}

export interface Board {
  from: string;
  to: string;
  time_zone: string;
  travel_speed_kmh: string;
  technicians: Lane[];
  unscheduled: Job[];
}

/** Statuses that hold a technician's time. */
export const ACTIVE = ["Scheduled", "Dispatched", "En Route", "On Site"];
/** Statuses a visit can be moved in: once the technician is on the way, the visit is theirs. */
export const MOVABLE = ["Scheduled", "Dispatched"];
/** The board snaps to quarter hours, and a visit is at least one. */
export const STEP = 15;
const MIN_MS = STEP * MINUTE;
/** What a job is given when nobody said how long it takes (the settings' default). */
export const DEFAULT_MINUTES = 60;

export const isBusy = (v: Pick<Visit, "status">) => ACTIVE.includes(v.status);
export const isMovable = (v: Pick<Visit, "status">) => MOVABLE.includes(v.status);

const ms = (iso: string) => Date.parse(iso);
const hours = (v: string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ───────────────────────────── the axis ─────────────────────────────

/** The stretch of a day the board shows, in the workspace's zone. */
export interface Axis {
  day: string;
  zone: string;
  /** Epoch ms of its start and end. */
  start: number;
  end: number;
  /** Epoch ms of each whole hour on it, first to last. */
  ticks: number[];
  /** Its length in minutes. */
  minutes: number;
}

const FIRST_HOUR = 7;
const LAST_HOUR = 19;

/** The day from seven to seven, stretched to hold every working window and visit on it with an
 *  hour to spare, so travel to the first job and the end of the last are not cut off. */
export function axisFor(day: string, zone: string, lanes: Pick<Lane, "working_hours" | "appointments">[]): Axis {
  const midnight = instantOf(day, 0, zone);
  const next = instantOf(addDays(day, 1), 0, zone);
  let lo = Infinity;
  let hi = -Infinity;
  const take = (a: number, z: number) => {
    const from = Math.max(a, midnight);
    const to = Math.min(z, next);
    if (to > from) {
      lo = Math.min(lo, from);
      hi = Math.max(hi, to);
    }
  };
  for (const lane of lanes) {
    for (const w of lane.working_hours) take(ms(w.start), ms(w.end));
    for (const v of lane.appointments) take(ms(v.start), ms(v.end));
  }
  // The hours are on the wall clock, which a day with a clock change counts differently from the
  // time that passes on it.
  const wallMinutes = (t: number) => {
    const w = wall(t, zone);
    return daysBetween(day, dayOf(t, zone)) * 1440 + w.hour * 60 + w.minute;
  };
  let first = FIRST_HOUR;
  let last = LAST_HOUR;
  if (Number.isFinite(lo)) {
    first = Math.min(first, Math.floor(wallMinutes(lo) / 60) - 1);
    last = Math.max(last, Math.ceil(wallMinutes(hi) / 60) + 1);
  }
  first = Math.max(0, first);
  last = Math.min(24, last);
  const start = instantOf(day, first * 60, zone);
  const end = instantOf(day, last * 60, zone);
  const ticks: number[] = [];
  for (let h = first; h <= last; h++) ticks.push(instantOf(day, h * 60, zone));
  return { day, zone, start, end, ticks, minutes: Math.round((end - start) / MINUTE) };
}

/** Minutes from the start of the axis. */
export const at = (axis: Axis, t: number) => (t - axis.start) / MINUTE;

// ───────────────────────────── lanes ─────────────────────────────

export interface Placed {
  visit: Visit;
  /** Minutes from the axis start, cut to the axis. */
  from: number;
  to: number;
  /** The visit goes on past the axis at that end. */
  cutStart: boolean;
  cutEnd: boolean;
  /** The stack the visit sits in: visits that overlap (one is finished or abandoned) do not hide each other. */
  row: number;
  /** The drive to it, ending where it starts. */
  travel: { from: number; to: number; minutes: number; origin: string } | null;
  /** Minutes the technician would arrive late after the visit they come from; 0 when it fits. */
  late: number;
}

/** The lane's visits positioned on the axis, those that touch it only. */
export function place(lane: Pick<Lane, "appointments">, axis: Axis): { items: Placed[]; rows: number } {
  const sorted = [...lane.appointments].sort((a, b) => ms(a.start) - ms(b.start) || ms(a.end) - ms(b.end));
  const ends: number[] = [];
  const items: Placed[] = [];
  for (const v of sorted) {
    const [a, z] = [ms(v.start), ms(v.end)];
    let row = ends.findIndex((e) => e <= a);
    if (row < 0) row = ends.length;
    ends[row] = z;
    if (z <= axis.start || a >= axis.end) continue;
    const from = Math.max(0, at(axis, a));
    const to = Math.min(axis.minutes, at(axis, z));
    let travel: Placed["travel"] = null;
    let late = 0;
    if (v.travel && v.travel.minutes > 0) {
      const begins = at(axis, a);
      travel = { from: Math.max(0, begins - v.travel.minutes), to: Math.max(0, begins), minutes: v.travel.minutes, origin: v.travel.from };
      if (travel.to <= travel.from) travel = null;
      const origin = v.travel.from === "home" ? undefined : sorted.find((o) => o.number === v.travel?.from);
      if (origin) late = Math.max(0, v.travel.minutes - Math.round((a - ms(origin.end)) / MINUTE));
    }
    items.push({ visit: v, from, to, cutStart: at(axis, a) < 0, cutEnd: at(axis, z) > axis.minutes, row, travel, late });
  }
  return { items, rows: Math.max(1, ends.length) };
}

/** The parts of the axis outside the technician's working hours (all of it on a day off); none for
 *  a technician with no hours set. */
export function offHours(lane: Pick<Lane, "working_hours" | "available_hours">, axis: Axis): { from: number; to: number }[] {
  if (lane.available_hours === null) return [];
  const work = lane.working_hours
    .map((w) => [Math.max(0, at(axis, ms(w.start))), Math.min(axis.minutes, at(axis, ms(w.end)))] as const)
    .filter(([a, z]) => z > a)
    .sort((x, y) => x[0] - y[0]);
  const out: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const [a, z] of work) {
    if (a > cursor) out.push({ from: cursor, to: a });
    cursor = Math.max(cursor, z);
  }
  if (cursor < axis.minutes) out.push({ from: cursor, to: axis.minutes });
  return out;
}

/** Hours of busy visits within [from, to), the way the server counts them. */
export function bookedHours(visits: Pick<Visit, "status" | "start" | "end">[], from: number, to: number): number {
  const total = visits.filter(isBusy).reduce((sum, v) => sum + Math.max(0, Math.min(ms(v.end), to) - Math.max(ms(v.start), from)), 0);
  return Math.round((total / HOUR) * 100) / 100;
}

const trim = (n: number) => String(Number(n.toFixed(2)));

export interface Load {
  booked: number;
  available: number | null;
  /** Booked over available, 0 to 1 for the meter. */
  ratio: number;
  /** More is booked than the working hours hold. */
  over: boolean;
  text: string;
}

/** How full a technician's day is. */
export function load(lane: Pick<Lane, "booked_hours" | "available_hours">): Load {
  const booked = hours(lane.booked_hours);
  const available = lane.available_hours === null ? null : hours(lane.available_hours);
  if (available === null) return { booked, available, ratio: 0, over: false, text: booked ? `${trim(booked)} h booked` : "Free" };
  if (available === 0) return { booked, available, ratio: booked ? 1 : 0, over: booked > 0, text: booked ? `${trim(booked)} h booked on a day off` : "Not working" };
  return { booked, available, ratio: Math.min(1, booked / available), over: booked > available, text: `${trim(booked)} of ${trim(available)} h` };
}

// ───────────────────────────── drops and resizes ─────────────────────────────

/** The slot a held visit would take when let go `minutes` from the start of the axis: its start
 *  snapped to the quarter hour, kept on the axis. `grab` is how far into the visit it was picked up. */
export function slotAt(axis: Axis, minutes: number, length: number, grab = 0): { start: number; end: number } {
  const from = Math.min(Math.max(0, snap(minutes - grab, STEP)), Math.max(0, axis.minutes - STEP));
  return { start: axis.start + from * MINUTE, end: axis.start + (from + length) * MINUTE };
}

/** A visit with one edge moved by `delta` minutes (snapped), never shorter than a quarter hour. */
export function resized(slot: { start: number; end: number }, edge: "start" | "end", delta: number): { start: number; end: number } {
  const d = snap(delta, STEP) * MINUTE;
  if (edge === "end") return { start: slot.start, end: Math.max(slot.start + MIN_MS, slot.end + d) };
  return { start: Math.min(slot.end - MIN_MS, slot.start + d), end: slot.end };
}

/** The length a job is planned for, in minutes. */
export const lengthOf = (job: Pick<Job, "estimated_duration_minutes">) => (job.estimated_duration_minutes && job.estimated_duration_minutes > 0 ? job.estimated_duration_minutes : DEFAULT_MINUTES);

// ───────────────────────────── the board once a move is accepted ─────────────────────────────

const iso = (t: number) => new Date(t).toISOString();

function counted(board: Board, lane: Lane): Lane {
  const zone = board.time_zone;
  return { ...lane, booked_hours: String(bookedHours(lane.appointments, instantOf(board.from, 0, zone), instantOf(addDays(board.to, 1), 0, zone))) };
}

/** A queued job taken by a technician at a time: it leaves the queue and joins the lane. The
 *  appointment's number and travel are the server's to work out. */
export function withJobScheduled(board: Board, workOrder: string, technician: string, start: number, end: number): Board {
  const job = board.unscheduled.find((j) => j.work_order === workOrder);
  if (!job) return board;
  const visit: Visit = {
    appointment: `pending-${workOrder}`,
    number: "",
    status: "Scheduled",
    start: iso(start),
    end: iso(end),
    actual_start: null,
    actual_end: null,
    work_order: workOrder,
    work_order_number: job.number,
    customer_name: job.customer_name,
    priority: job.priority,
    site: job.site,
    travel: null,
  };
  return {
    ...board,
    unscheduled: board.unscheduled.filter((j) => j !== job),
    technicians: board.technicians.map((l) => (l.technician === technician ? counted(board, { ...l, appointments: [...l.appointments, visit] }) : l)),
  };
}

/** A visit moved to a time, and to another technician's lane (or added to it with `add`). Moving
 *  a dispatched visit sends it back to Scheduled: the server asks for it to be dispatched again. */
export function withVisitMoved(board: Board, appointment: string, to: { technician: string; start: number; end: number; from?: string; add?: boolean }): Board {
  const source = board.technicians.find((l) => (!to.from || l.technician === to.from) && l.appointments.some((v) => v.appointment === appointment));
  const visit = source?.appointments.find((v) => v.appointment === appointment);
  if (!source || !visit) return board;
  const moved: Visit = { ...visit, start: iso(to.start), end: iso(to.end), status: visit.status === "Dispatched" ? "Scheduled" : visit.status, travel: null };
  return {
    ...board,
    technicians: board.technicians.map((lane) => {
      const has = lane.appointments.some((v) => v.appointment === appointment);
      const target = lane.technician === to.technician;
      if (!has && !target) return lane;
      // Everyone on the visit keeps it as it is now: the crew's blocks follow it in time.
      let visits = lane.appointments.map((v) => (v.appointment === appointment ? moved : v));
      if (lane.technician === source.technician && !target && !to.add) visits = visits.filter((v) => v.appointment !== appointment);
      if (target && !has) visits = [...visits, moved];
      return counted(board, { ...lane, appointments: visits });
    }),
  };
}

/** A visit given another status (dispatched), or taken off the board (cancelled). */
export function withVisitStatus(board: Board, appointment: string, status: string | null): Board {
  return {
    ...board,
    technicians: board.technicians.map((lane) =>
      lane.appointments.some((v) => v.appointment === appointment)
        ? counted(board, { ...lane, appointments: status ? lane.appointments.map((v) => (v.appointment === appointment ? { ...v, status } : v)) : lane.appointments.filter((v) => v.appointment !== appointment) })
        : lane,
    ),
  };
}

/** The hours the day's technicians work, from the first to start to the last to finish (the whole
 *  axis when none has working hours set). */
export function workday(lanes: Pick<Lane, "working_hours">[], axis: Pick<Axis, "start" | "end">): { start: number; end: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const lane of lanes) {
    for (const w of lane.working_hours) {
      const [a, z] = [Math.max(ms(w.start), axis.start), Math.min(ms(w.end), axis.end)];
      if (z > a) {
        lo = Math.min(lo, a);
        hi = Math.max(hi, z);
      }
    }
  }
  return Number.isFinite(lo) ? { start: lo, end: hi } : { start: axis.start, end: axis.end };
}

/** Times to try for a job, best first: when the customer asked for it, then on the hour through the
 *  working day, never in the past. */
export function candidateSlots(job: Pick<Job, "estimated_duration_minutes" | "preferred_start">, work: { start: number; end: number }, now: number, limit = 8): { start: number; end: number }[] {
  const length = lengthOf(job) * MINUTE;
  const ahead = Math.ceil(now / MIN_MS) * MIN_MS;
  const starts: number[] = [];
  const preferred = job.preferred_start ? Date.parse(job.preferred_start) : NaN;
  if (Number.isFinite(preferred)) starts.push(preferred);
  for (let t = Math.max(work.start, ahead); t + length <= work.end; t += HOUR) starts.push(t);
  return [...new Set(starts)]
    .filter((t) => t >= work.start && t >= ahead && t + length <= work.end)
    .slice(0, limit)
    .map((t) => ({ start: t, end: t + length }));
}

// ───────────────────────────── queue and dispatch ─────────────────────────────

/** The skills the waiting jobs ask for, for the filter. */
export function skillsAsked(jobs: Pick<Job, "required_skills">[]): string[] {
  return [...new Set(jobs.flatMap((j) => j.required_skills))].sort((a, b) => a.localeCompare(b));
}

/** The waiting jobs that need a skill and match a search of what their card shows, in the order the server gave. */
export function queueFilter(jobs: Job[], o: { skill?: string | null; q?: string }): Job[] {
  const q = (o.q ?? "").trim().toLowerCase();
  return jobs.filter(
    (j) => (!o.skill || j.required_skills.includes(o.skill)) && (!q || [j.customer_name, j.number, j.work_type, j.territory_name, ...j.required_skills].some((v) => v?.toLowerCase().includes(q))),
  );
}

/** Visits planned but not yet sent to their technicians, one per work order. */
export function undispatched(board: Board): Visit[] {
  const seen = new Set<string>();
  return board.technicians
    .flatMap((l) => l.appointments)
    .filter((v) => v.status === "Scheduled" && !v.appointment.startsWith("pending-") && !seen.has(v.work_order) && seen.add(v.work_order))
    .sort((a, b) => ms(a.start) - ms(b.start));
}

/** Every crew member's lane a visit is in. */
export const crewOf = (board: Board, appointment: string) => board.technicians.filter((l) => l.appointments.some((v) => v.appointment === appointment)).map((l) => l.technician);

// ───────────────────────────── the keyboard ─────────────────────────────

/** The visit an arrow key moves to: left and right along the lane, up and down to the nearest
 *  start in the next lane that has any. */
export function neighbour(lanes: Pick<Lane, "appointments">[], current: string, key: string): string | null {
  const sorted = lanes.map((l) => [...l.appointments].sort((a, b) => ms(a.start) - ms(b.start)));
  const li = sorted.findIndex((l) => l.some((v) => v.appointment === current));
  if (li < 0) return null;
  const pi = sorted[li].findIndex((v) => v.appointment === current);
  if (key === "ArrowLeft") return sorted[li][pi - 1]?.appointment ?? null;
  if (key === "ArrowRight") return sorted[li][pi + 1]?.appointment ?? null;
  const step = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
  if (!step) return null;
  const here = ms(sorted[li][pi].start);
  for (let i = li + step; i >= 0 && i < sorted.length; i += step) {
    if (!sorted[i].length) continue;
    return sorted[i].reduce((best, v) => (Math.abs(ms(v.start) - here) < Math.abs(ms(best.start) - here) ? v : best)).appointment;
  }
  return null;
}

// ───────────────────────────── a week ─────────────────────────────

export interface Cell {
  day: string;
  /** Hours of visits that hold the technician's time, and the working hours (null: no hours set). */
  booked: number;
  available: number | null;
  /** Visits that hold their time on the day. */
  visits: number;
  /** More is booked than the day's hours hold. */
  over: boolean;
}

/** Each technician's week as days of how full they are, from a board read over those days. */
export function weekOf(board: Pick<Board, "technicians" | "time_zone">, first: string): { days: string[]; rows: { lane: Lane; cells: Cell[] }[] } {
  const days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  const zone = board.time_zone;
  const rows = board.technicians.map((lane) => ({
    lane,
    cells: days.map((day): Cell => {
      const [a, z] = [instantOf(day, 0, zone), instantOf(addDays(day, 1), 0, zone)];
      const busy = lane.appointments.filter((v) => isBusy(v) && ms(v.start) < z && ms(v.end) > a);
      const booked = bookedHours(busy, a, z);
      const available =
        lane.available_hours === null
          ? null
          : Math.round((lane.working_hours.reduce((sum, w) => sum + Math.max(0, Math.min(ms(w.end), z) - Math.max(ms(w.start), a)), 0) / HOUR) * 100) / 100;
      return { day, booked, available, visits: busy.length, over: available !== null && booked > available };
    }),
  }));
  return { days, rows };
}
