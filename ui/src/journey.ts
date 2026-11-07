// A technician's day: their visits in order with the drive to each, the one to do next, how to get
// there, and what the dispatcher changed since they last looked. Pure, so it is tested without a
// browser.

import { type Board, type Lane, type Visit } from "./board";
import { clock, dayLabel, dayOf } from "./time";
import { t } from "@ferrum/client";

/** The work order behind a visit, as far as the day's list shows it. */
export interface Details {
  id: string;
  customer_name?: string | null;
  site_address?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  priority?: string | null;
  work_type?: string | null;
  description?: string | null;
  status?: string | null;
  sla_status?: string | null;
  response_due?: string | null;
  resolution_due?: string | null;
  response_breached?: boolean | null;
  resolution_breached?: boolean | null;
  arrived_at?: string | null;
  completed_at?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  serial_no?: string | null;
  _titles?: Record<string, string>;
}

export interface Stop {
  visit: Visit;
  job: Details | undefined;
}

/** The technician with this email address: a person with one record of their own sees only theirs. */
export function laneOf(board: Board, email: string | undefined): Lane | undefined {
  const me = (email ?? "").trim().toLowerCase();
  return me ? board.technicians.find((l) => (l.user_email ?? "").toLowerCase() === me) : undefined;
}

const UNDER_WAY = ["En Route", "On Site"];
const DONE = ["Completed", "Cannot Complete"];

export interface Day {
  /** The job being worked now: on the way, or on site. */
  now: Stop | null;
  /** The next one to go to (the first planned, when none is under way). */
  next: Stop | null;
  later: Stop[];
  done: Stop[];
}

/** The visits in the order they happen, split into what is under way, what is next, what follows and what is finished. */
export function arrange(visits: Visit[], details: Map<string, Details>): Day {
  const stops: Stop[] = [...visits]
    .filter((v) => v.status !== "Cancelled")
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((visit) => ({ visit, job: details.get(visit.work_order) }));
  const now = stops.find((s) => UNDER_WAY.includes(s.visit.status)) ?? null;
  const open = stops.filter((s) => !DONE.includes(s.visit.status) && s !== now);
  return { now, next: now ? null : (open[0] ?? null), later: now ? open : open.slice(1), done: stops.filter((s) => DONE.includes(s.visit.status)) };
}

export type Step = { action: "start_travel" | "arrive" | "complete"; label: string } | null;

/** What a technician does next on a job; null when it is not theirs to move (waiting for dispatch, finished). */
export function nextStep(status: string | null | undefined): Step {
  switch (status) {
    case "Dispatched":
      return { action: "start_travel", label: t("Start travel") };
    case "En Route":
      return { action: "arrive", label: t("I've arrived") };
    case "On Site":
      return { action: "complete", label: t("Complete the job") };
    default:
      return null;
  }
}

/** The words for a job that has no next step for the technician. */
export function waiting(status: string | null | undefined): string | null {
  switch (status) {
    case "New":
    case "Scheduled":
      return "Waiting for the dispatcher to send this job.";
    case "Completed":
    case "Invoiced":
      return "Done.";
    case "Cancelled":
      return "This job was cancelled.";
    default:
      return null;
  }
}

/** A link that opens the route in the phone's own maps: by coordinates when the job has them, else by address. */
export function directionsUrl(job: Pick<Details, "latitude" | "longitude" | "site_address"> | undefined): string | null {
  if (!job) return null;
  const point = job.latitude && job.longitude ? `${job.latitude},${job.longitude}` : null;
  const place = point ?? job.site_address?.replace(/\s+/g, " ").trim();
  return place ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}` : null;
}

/** A phone number as a link: digits and a leading plus only. */
export function telUrl(phone: string | null | undefined): string | null {
  const n = (phone ?? "").replace(/[^\d+]/g, "");
  return n.replace(/\+/g, "").length >= 3 ? `tel:${n}` : null;
}

export interface Seen {
  appointment: string;
  number: string;
  start: string;
  end: string;
  status: string;
}

export const seen = (visits: Visit[]): Seen[] => visits.map((v) => ({ appointment: v.appointment, number: v.work_order_number, start: v.start, end: v.end, status: v.status }));

/** What the dispatcher changed between two looks at the day, in words. A visit the technician moved
 *  on in themselves (on the way, on site, finished) is theirs, not news. */
export function changes(before: Seen[], after: Seen[], zone: string): string[] {
  const out: string[] = [];
  const when = (s: Seen) => `${clock(Date.parse(s.start), zone)}–${clock(Date.parse(s.end), zone)}`;
  for (const b of before) {
    const a = after.find((x) => x.appointment === b.appointment);
    if (!a) {
      if (!DONE.includes(b.status)) out.push(t("{number} is no longer on your day.", { number: b.number }));
    } else if (a.start !== b.start || a.end !== b.end) out.push(t("{number} moved to {a}.", { number: a.number, a: when(a) }));
    else if (b.status === "Dispatched" && a.status === "Scheduled") out.push(t("{number} is waiting to be dispatched again.", { number: a.number }));
  }
  for (const a of after) if (!before.some((b) => b.appointment === a.appointment)) out.push(t("{number} was added to your day: {a}.", { number: a.number, a: when(a) }));
  return out;
}

/** What the dispatcher did to an open job's time, in a sentence; null when its time did not change. */
export function rescheduled(before: Record<string, unknown> | undefined, after: Record<string, unknown>, zone: string): string | null {
  if (!before || (before.scheduled_start === after.scheduled_start && before.scheduled_end === after.scheduled_end)) return null;
  const [a, z] = [Date.parse(String(after.scheduled_start ?? "")), Date.parse(String(after.scheduled_end ?? ""))];
  if (!Number.isFinite(a) || !Number.isFinite(z)) return "The dispatcher took this job off the schedule.";
  return t("The dispatcher moved this job to {value}, {a}–{z}.", { value: dayLabel(dayOf(a, zone)), a: clock(a, zone), z: clock(z, zone) });
}
