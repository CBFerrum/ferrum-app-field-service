// What the service-level clock says about a job, in a few words for a chip. The server judges
// (On Track, At Risk, Breached, Met) and keeps it current; this only phrases what it said, with the
// time left or overrun taken from the deadline that is still running. Pure, so it is tested.

import { dayOf, span, stamp } from "./time";
import { t } from "@ferrum/client";

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
  const title = Number.isFinite(due) ? (responded ? t("Resolution due {when}", { when: stamp(due, zone) }) : t("Response due {when}", { when: stamp(due, zone) })) : t("Service level: {status}", { status });
  if (status === "Met") return { tone: "green", text: "Service level met", title };
  if (status === "Breached") {
    if (done) return { tone: "red", text: w.resolution_breached ? "Finished late" : "Arrived late", title };
    if (responded && !w.resolution_breached) return { tone: "red", text: "Arrived late", title };
    if (Number.isFinite(due) && now > due) return { tone: "red", text: t("{value} overdue", { value: span(now - due) }), title };
    return { tone: "red", text: "Service level missed", title };
  }
  const left = Number.isFinite(due) ? due - now : null;
  const goal = responded ? "Finish" : "Arrive";
  if (status === "At Risk") return { tone: "amber", text: left != null && left > 0 ? t("{goal} within {left}", { goal, left: span(left) }) : t("{goal} soon", { goal }), title };
  const today = Number.isFinite(due) && dayOf(due, zone) === dayOf(now, zone);
  return { tone: "neutral", text: left != null && left > 0 ? (today ? t("{goal} within {left}", { goal, left: span(left) }) : t("Due {due}", { due: stamp(due, zone) })) : status, title };
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
  const one = (label: string, dueAt: string | null | undefined, doneAt: string | null | undefined, arrived: boolean) => {
    const due = dueAt ? Date.parse(dueAt) : NaN;
    if (!Number.isFinite(due)) return;
    const done = doneAt ? Date.parse(doneAt) : NaN;
    if (Number.isFinite(done)) {
      const early = due - done;
      out.push(
        early >= 0
          ? {
              label,
              due,
              state: "met",
              text:
                early < 60_000
                  ? arrived ? t("Arrived just in time") : t("Finished just in time")
                  : arrived ? t("Arrived {early} before the deadline", { early: span(early) }) : t("Finished {early} before the deadline", { early: span(early) }),
            }
          : { label, due, state: "late", text: arrived ? t("Arrived {late} after the deadline", { late: span(-early) }) : t("Finished {late} after the deadline", { late: span(-early) }) },
      );
    } else if (now > due) out.push({ label, due, state: "overdue", text: t("{value} overdue", { value: span(now - due) }) });
    else out.push({ label, due, state: "running", text: t("{value} left", { value: span(due - now) }) });
  };
  one(t("Arrive within"), w.response_due, w.arrived_at, true);
  one(t("Finish within"), w.resolution_due, w.completed_at, false);
  return out;
}
