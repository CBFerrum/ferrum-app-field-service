// The job chosen on the board: what it is and where, its visit, and the planning that a drag does
// by hand — a time, then the technicians ranked for it with their scores and reasons, each a
// button. It is the way to schedule or move a job from a keyboard or a phone.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, docPath, t, isolate } from "@ferrum/client";
import { Alert, Badge, Button, Icon, ListSkeleton, Spinner } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { suggest, type Suggestion } from "./api";
import { type Board, isBusy, isMovable, type Job, lengthOf, STEP, type Visit } from "./board";
import type { Slot } from "./Lanes";
import { slaChip } from "./sla";
import { priorityTone, tone } from "./status";
import { clock, fromWallInput, MINUTE, span, stamp, wallInput } from "./time";

export interface DrawerOps {
  /** Each resolves to the reason it was refused, or null when it was done. */
  assign: (job: Job, lane: string, slot: Slot) => Promise<string | null>;
  relocate: (visit: Visit, from: string, to: string, slot: Slot, add: boolean) => Promise<string | null>;
  dispatch: (visit: Visit) => Promise<string | null>;
  cancel: (visit: Visit) => Promise<string | null>;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A technician's fitness for a slot, as a badge: the server's score, or why not. */
function Score({ s }: { s: Suggestion }) {
  const tone = !s.eligible ? "red" : s.score >= 70 ? "green" : s.score >= 40 ? "amber" : "neutral";
  return (
    <Badge tone={tone} title={s.eligible ? t("Score {score} of 100", { score: s.score }) : t("Cannot take it at this time")}>
      {s.eligible ? s.score : t("Can't")}
    </Badge>
  );
}

/** A time, and the technicians the server ranks for it. */
function Plan({
  workOrder,
  zone,
  firstStart,
  minutes,
  crew,
  mode,
  busy,
  onPick,
}: {
  workOrder: string;
  zone: string;
  firstStart: number;
  minutes: number;
  crew: string[];
  mode: "job" | "visit";
  busy: boolean;
  onPick: (s: Suggestion, slot: Slot, add: boolean) => void;
}) {
  const [when, setWhen] = useState(wallInput(firstStart, zone));
  const [length, setLength] = useState(minutes);
  const start = fromWallInput(when, zone);
  const end = start != null && length >= STEP ? start + length * MINUTE : null;
  const ranked = useQuery({
    queryKey: ["fs", "suggest", workOrder, start, end],
    enabled: start != null && end != null,
    staleTime: 30_000,
    queryFn: ({ signal }) => suggest(workOrder, start!, end!, signal),
  });
  return (
    <section className="fs-plan" aria-label={mode === "job" ? t("Schedule this job") : t("Move this visit")}>
      <h3 className="fs-drawer-h">{mode === "job" ? t("Who can take it") : t("Move it to")}</h3>
      <div className="fs-plan-when">
        <label>
          <span className="field-label">{t("Starts")}</span>
          <input className="input" type="datetime-local" step={STEP * 60} value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("Minutes")}</span>
          <input className="input" type="number" min={STEP} step={STEP} value={length} onChange={(e) => setLength(Number(e.target.value))} />
        </label>
      </div>
      {end == null ? (
        <p className="muted">{t("Choose a start and how long it takes.")}</p>
      ) : ranked.error ? (
        <Alert tone="error">{ranked.error instanceof Error ? ranked.error.message : t("The ranking could not be loaded.")}</Alert>
      ) : !ranked.data ? (
        <Spinner label={t("Ranking the technicians")} />
      ) : !ranked.data.technicians.length ? (
        <p className="muted">{t("There are no technicians to rank.")}</p>
      ) : (
        <ul className="fs-suggest">
          {ranked.data.technicians.map((s) => {
            const on = crew.includes(s.technician);
            const slot = { start: start!, end: end };
            return (
              <li key={s.technician} data-eligible={s.eligible || undefined}>
                <div className="fs-suggest-main">
                  <div className="fs-suggest-name">
                    <strong>{isolate(s.technician_name)}</strong>
                    <Score s={s} />
                  </div>
                  <p className="faint">{isolate(s.reasons.join(" · "))}</p>
                </div>
                <div className="fs-suggest-act">
                  {mode === "job" ? (
                    <Button size="sm" variant={s.eligible ? "primary" : "default"} disabled={busy} onClick={() => onPick(s, slot, false)}>
                      {s.eligible ? t("Assign") : t("Assign anyway")}
                    </Button>
                  ) : on ? (
                    <Button size="sm" disabled={busy} onClick={() => onPick(s, slot, false)} title={t("Keep them on the visit, at this time")}>
                      {t("Keep")}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant={s.eligible ? "primary" : "default"} disabled={busy} onClick={() => onPick(s, slot, false)} title={t("Give the visit to this technician")}>
                        {t("Move here")}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => onPick(s, slot, true)} title={t("Add this technician to the visit")}>
                        {t("Add")}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Drawer({
  board,
  workOrder,
  canPlan,
  now,
  startHint,
  ops,
  moving,
  onMoving,
  onClose,
}: {
  board: Board;
  workOrder: string;
  canPlan: boolean;
  now: number;
  /** When to suggest starting a waiting job: the best time the day still has. */
  startHint: number;
  ops: DrawerOps;
  /** The visit's own planning is open (the board's M key opens it too). */
  moving: boolean;
  onMoving: (open: boolean) => void;
  onClose: () => void;
}) {
  const zone = board.time_zone;
  const job = board.unscheduled.find((j) => j.work_order === workOrder);
  const placed = board.technicians.flatMap((l) => l.appointments.filter((v) => v.work_order === workOrder).map((v) => ({ lane: l, visit: v })));
  // The visit under way or still to come, rather than an earlier one that was finished.
  const main = placed.find((p) => isBusy(p.visit)) ?? placed[0];
  const visit = main?.visit;
  const crew = placed.filter((p) => p.visit.appointment === visit?.appointment).map((p) => p.lane);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = useQuery({ queryKey: ["fs", "wo", workOrder], queryFn: ({ signal }) => api.get<Doc>(docPath("ServiceWorkOrder", workOrder), { titles: true }, signal), staleTime: 30_000 });
  const wo = record.data;
  const number = job?.number ?? visit?.work_order_number ?? text(wo?.number) ?? "Work order";
  const customer = job?.customer_name ?? visit?.customer_name ?? text(wo?.customer_name) ?? "";
  const sla = slaChip(
    {
      sla_status: job?.sla_status ?? text(wo?.sla_status),
      response_due: job?.response_due ?? text(wo?.response_due),
      resolution_due: job?.resolution_due ?? text(wo?.resolution_due),
      response_breached: job?.response_breached ?? wo?.response_breached === true,
      resolution_breached: wo?.resolution_breached === true,
      arrived_at: text(wo?.arrived_at),
      completed_at: text(wo?.completed_at),
    },
    now,
    zone,
  );
  const priority = job?.priority ?? visit?.priority ?? text(wo?.priority);
  const workType = job?.work_type ?? text(wo?.work_type);
  const minutes = job ? lengthOf(job) : visit ? Math.round((Date.parse(visit.end) - Date.parse(visit.start)) / MINUTE) : 60;
  const firstStart = visit ? Date.parse(visit.start) : startHint;
  const skills = job?.required_skills ?? [];
  const run = async (f: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const said = await f();
    setBusy(false);
    if (said) setError(said);
    else onMoving(false);
  };
  const address = text(wo?.site_address);
  const phone = text(wo?.contact_phone);
  const contact = text(wo?.contact_name);
  const equipment = typeof wo?._titles === "object" ? (wo?._titles as Record<string, string>).equipment : undefined;
  const description = text(wo?.description);

  return (
    <aside className="fs-drawer" tabIndex={-1} aria-label={`${number}, ${customer}`} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <header className="fs-drawer-head">
        <div>
          <Link className="fs-drawer-title" to={`/w/${workOrder}`}>
            {isolate(number)}
          </Link>
          <p className="muted">{isolate(customer)}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={t("Close")} title={t("Close (Esc)")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="fs-drawer-body">
        <div className="fs-drawer-chips">
          {priority && <Badge tone={priorityTone(priority)}>{isolate(priority)}</Badge>}
          {workType && <Badge>{isolate(workType)}</Badge>}
          {text(wo?.status) && <Badge tone={tone(String(wo?.status))}>{isolate(String(wo?.status))}</Badge>}
          {sla && (
            <Badge tone={sla.tone} title={sla.title}>
              {isolate(sla.text)}
            </Badge>
          )}
        </div>

        {visit && (
          <section className="fs-visit" aria-label={t("The visit")}>
            <h3 className="fs-drawer-h">{t("Visit")}</h3>
            <p>
              <strong>{isolate(stamp(Date.parse(visit.start), zone))}</strong>–{isolate(clock(Date.parse(visit.end), zone))} <span className="faint">({isolate(span(minutes * MINUTE))})</span>
            </p>
            <p className="muted">{isolate(crew.map((l) => l.technician_name).join(", "))}</p>
            {visit.status === "Scheduled" ? (
              <Alert tone="warning">{t("Planned, not sent. Dispatching tells the technician, and the customer if they have an email on file.")}</Alert>
            ) : (
              <p>
                <Badge tone={tone(visit.status)}>{isolate(visit.status)}</Badge>
              </p>
            )}
            {!isMovable(visit) && visit.status !== "Completed" && visit.status !== "Cannot Complete" && <p className="muted">{t("The technician has this one: it can no longer be moved.")}</p>}
            {canPlan && (
              <div className="fs-visit-actions">
                {visit.status === "Scheduled" && (
                  <Button variant="primary" loading={busy} onClick={() => void run(() => ops.dispatch(visit))}>
                    {t("Dispatch")}
                  </Button>
                )}
                {isMovable(visit) && (
                  <Button aria-expanded={moving} onClick={() => onMoving(!moving)}>
                    {moving ? t("Keep it here") : t("Reschedule…")}
                  </Button>
                )}
                {["Scheduled", "Dispatched", "En Route"].includes(visit.status) && (
                  <Button variant="danger" disabled={busy} onClick={() => void run(() => ops.cancel(visit))}>
                    {t("Cancel visit")}
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        <dl className="fs-facts">
          {address && (
            <>
              <dt>{t("Where")}</dt>
              <dd className="fs-pre">{isolate(address)}</dd>
            </>
          )}
          {(contact || phone) && (
            <>
              <dt>{t("Contact")}</dt>
              <dd>
                {isolate(contact ?? "")}
                {contact && phone ? " · " : ""}
                {phone && <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{isolate(phone)}</a>}
              </dd>
            </>
          )}
          {equipment && (
            <>
              <dt>{t("Equipment")}</dt>
              <dd>{isolate(equipment)}</dd>
            </>
          )}
          {skills.length > 0 && (
            <>
              <dt>{t("Needs")}</dt>
              <dd>{isolate(skills.join(", "))}</dd>
            </>
          )}
          {job && (
            <>
              <dt>{t("Planned")}</dt>
              <dd>{isolate(span(lengthOf(job) * MINUTE))}</dd>
            </>
          )}
          {job?.preferred_start && (
            <>
              <dt>{t("Customer asked for")}</dt>
              <dd>{isolate(stamp(Date.parse(job.preferred_start), zone))}</dd>
            </>
          )}
          {description && (
            <>
              <dt>{t("Problem")}</dt>
              <dd className="fs-pre fs-clamp">{isolate(description)}</dd>
            </>
          )}
        </dl>
        {record.isError && <p className="muted">{t("The job's details could not be loaded.")}</p>}
        {record.isPending && <ListSkeleton rows={3} />}

        {error && <Alert tone="error">{isolate(error)}</Alert>}

        {canPlan && job && (
          <Plan
            key={`job-${workOrder}`}
            workOrder={workOrder}
            zone={zone}
            firstStart={firstStart}
            minutes={minutes}
            crew={[]}
            mode="job"
            busy={busy}
            onPick={(s, slot) => void run(() => ops.assign(job, s.technician, slot))}
          />
        )}
        {canPlan && visit && moving && (
          <Plan
            key={`visit-${visit.appointment}`}
            workOrder={workOrder}
            zone={zone}
            firstStart={firstStart}
            minutes={minutes}
            crew={crew.map((l) => l.technician)}
            mode="visit"
            busy={busy}
            onPick={(s, slot, add) => {
              // Someone already on the visit keeps their place and only the time changes.
              const from = crew.some((l) => l.technician === s.technician) ? s.technician : (crew[0]?.technician ?? s.technician);
              void run(() => ops.relocate(visit, from, s.technician, slot, add));
            }}
          />
        )}
        {!job && !visit && <p className="muted">{t("This job is not on this day's board. Open it to see where it stands.")}</p>}
      </div>
    </aside>
  );
}
