// What the service-level clock says about a job, in a few words for a chip. The server judges
// (On Track, At Risk, Breached, Met) and keeps it current; this only phrases what it said, with the
// time left or overrun taken from the deadline that is still running. Pure, so it is tested.

import { dayOf, span, stamp } from "./time";

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";

export interface SlaFields {
  sla_status?: string | null;
  response_due?: string | null;
  resolution_due?: string | null;
  response_breached?: boolean | null;
  resolution_breached?: boolean | null;
  arrived_at?: string | null;
  completed_at?: string | null;
}

export interface Chip {
  tone: Tone;
  text: string;
  /** The deadline in full, for a tooltip. */
  title: string;
}

/** The chip for a job's service level, or null when it has none (no target for its priority). */
export function slaChip(w: SlaFields, now: number, zone: string): Chip | null {
  const status = w.sla_status;
  if (!status) return null;
  const responded = !!w.arrived_at;
  const done = !!w.completed_at;
  // The deadline still running: the response until someone is on site, then the resolution.
  const running = responded ? w.resolution_due : w.response_due;
  const due = running ? Date.parse(running) : NaN;
  const title = Number.isFinite(due) ? `${responded ? "Resolution" : "Response"} due ${stamp(due, zone)}` : `Service level: ${status}`;
  if (status === "Met") return { tone: "green", text: "Service level met", title };
  if (status === "Breached") {
    if (done) return { tone: "red", text: w.resolution_breached ? "Finished late" : "Arrived late", title };
    if (responded && !w.resolution_breached) return { tone: "red", text: "Arrived late", title };
    if (Number.isFinite(due) && now > due) return { tone: "red", text: `${span(now - due)} overdue`, title };
    return { tone: "red", text: "Service level missed", title };
  }
  const left = Number.isFinite(due) ? due - now : null;
  const goal = responded ? "Finish" : "Arrive";
  if (status === "At Risk") return { tone: "amber", text: left != null && left > 0 ? `${goal} within ${span(left)}` : `${goal} soon`, title };
  const today = Number.isFinite(due) && dayOf(due, zone) === dayOf(now, zone);
  return { tone: "neutral", text: left != null && left > 0 ? (today ? `${goal} within ${span(left)}` : `Due ${stamp(due, zone)}`) : status, title };
}

export interface Clock {
  label: string;
  /** When it is due, as epoch ms. */
  due: number;
  state: "met" | "late" | "running" | "overdue";
  text: string;
}

/** The two clocks of a job: how long until someone is on site, and until it is finished. A clock
 *  that has stopped says whether it stopped in time; one still running says how long is left. */
export function slaClocks(w: SlaFields, now: number): Clock[] {
  const out: Clock[] = [];
  const one = (label: string, dueAt: string | null | undefined, doneAt: string | null | undefined, did: string) => {
    const due = dueAt ? Date.parse(dueAt) : NaN;
    if (!Number.isFinite(due)) return;
    const done = doneAt ? Date.parse(doneAt) : NaN;
    if (Number.isFinite(done)) {
      const early = due - done;
      out.push(
        early >= 0
          ? { label, due, state: "met", text: `${did} ${early < 60_000 ? "just in time" : `${span(early)} before the deadline`}` }
          : { label, due, state: "late", text: `${did} ${span(-early)} after the deadline` },
      );
    } else if (now > due) out.push({ label, due, state: "overdue", text: `${span(now - due)} overdue` });
    else out.push({ label, due, state: "running", text: `${span(due - now)} left` });
  };
  one("Arrive within", w.response_due, w.arrived_at, "Arrived");
  one("Finish within", w.resolution_due, w.completed_at, "Finished");
  return out;
}
