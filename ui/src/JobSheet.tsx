// The job as the technician works it, on a phone: where it is and who to call, then the checklist,
// parts, time, expenses, photos and sign-off to fill in as they go, and a bar that is always in
// reach and offers only the next step: start travel, arrive, complete.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { type FieldError } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Icon, toast } from "@ferrum/kit";
import { directionsUrl, nextStep, rescheduled, telUrl, waiting } from "./journey";
import { gaps, type Gap, type Rules } from "./job";
import { scrollBehavior } from "./motion";
import { Photos, Signoff } from "./Proof";
import { sentence } from "./reason";
import { slaChip } from "./sla";
import { priorityTone, tone } from "./status";
import { type Ctx, Checklist, Expenses, Parts, Time } from "./Sections";
import { clock, dayLabel, dayOf, span } from "./time";
import type { Outcome } from "./useWork";

/** What the page needs from the work order's data. */
export interface View {
  ctx: Ctx;
  rules: Rules;
  /** Runs an action of the work order. */
  run: (action: string, body?: unknown) => Promise<Outcome>;
  setRefused: (f: FieldError[]) => void;
  now: number;
  /** The other way to see the same job, for someone who works and plans both. */
  switch: boolean;
  /** Changes made are still on their way to the server. */
  saving: boolean;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What the server refused on completing, as a list. */
export function Refusals({ list }: { list: FieldError[] }) {
  if (!list.length) return null;
  return (
    <Alert tone="error">
      <strong>The job cannot be completed yet.</strong>
      <ul>
        {list.map((f, i) => (
          <li key={i}>{sentence([f])}</li>
        ))}
      </ul>
    </Alert>
  );
}

function jump(section: Gap["section"]) {
  document.getElementById(section)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
}

export function JobSheet({ v }: { v: View }) {
  const { ctx } = v;
  const { doc } = ctx;
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const was = useRef(doc);
  // The dispatcher can move the job while it is open: say so, rather than quietly change the time.
  useEffect(() => {
    const said = rescheduled(was.current, doc, ctx.zone);
    if (said) setMoved(said);
    was.current = doc;
  }, [doc, ctx.zone]);
  const status = String(doc.status ?? "");
  const step = nextStep(status);
  const left = gaps(doc as Parameters<typeof gaps>[0], v.rules);
  const sla = slaChip({ ...doc } as Parameters<typeof slaChip>[0], v.now, ctx.zone);
  const maps = directionsUrl(doc as Parameters<typeof directionsUrl>[0]);
  const tel = telUrl(text(doc.contact_phone));
  const customer = text(doc.customer_name) ?? "Customer";
  const start = text(doc.scheduled_start);
  const end = text(doc.scheduled_end);
  const equipment = ((doc._titles ?? {}) as Record<string, string>).equipment;
  const note = waiting(status);

  const go = async (action: "start_travel" | "arrive" | "complete") => {
    if (action === "complete") {
      const ok = await confirmDialog({
        title: "Complete this job?",
        message: "The parts leave your van's stock and the job is locked. The customer's invoice follows from what you recorded.",
        confirmLabel: "Complete the job",
      });
      if (!ok) return;
    }
    setBusy(action);
    const out = await v.run(action);
    setBusy(null);
    if (!out.ok) {
      v.setRefused(out.fields);
      toast(out.fields.length ? "The job cannot be completed yet. See what is missing." : (out.message ?? "That did not work."), "error");
      if (out.fields.length) window.scrollTo({ top: 0, behavior: scrollBehavior() });
      return;
    }
    v.setRefused([]);
    if (action === "complete") {
      toast("Job completed.");
      navigate("/day");
    } else toast(action === "start_travel" ? "On your way." : "You are on site.");
  };

  return (
    <div className="fs-page fs-sheet">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/day">My day</Link>
        <Icon name="chevronRight" size={12} />
        {v.switch && (
          <Link className="fs-switch-view" to="?as=office">
            Office view
          </Link>
        )}
      </nav>
      <header className="fs-sheet-head">
        <div className="fs-sheet-title">
          <h1 className="page-title">{customer}</h1>
          <p className="page-sub">{[text(doc.number), text(doc.work_type)].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="fs-sheet-badges">
          {v.saving && (
            <span className="faint" role="status">
              Saving…
            </span>
          )}
          <Badge tone={tone(status)}>{status}</Badge>
          {(doc.priority === "Urgent" || doc.priority === "High") && <Badge tone={priorityTone(String(doc.priority))}>{String(doc.priority)}</Badge>}
          {sla && (
            <Badge tone={sla.tone} title={sla.title}>
              {sla.text}
            </Badge>
          )}
        </div>
      </header>
      {moved && (
        <Alert tone="warning" action={<Button size="sm" onClick={() => setMoved(null)}>Got it</Button>}>
          {moved}
        </Alert>
      )}
      <Refusals list={ctx.refused.filter((f) => !f.row || f.row[0] === "checklist")} />
      {status === "Cancelled" && <Alert tone="error">This job was cancelled{text(doc.cancellation_reason) ? `: ${text(doc.cancellation_reason)}` : "."}</Alert>}

      <section className="fs-sec fs-where" aria-label="Where and who">
        {text(doc.site_address) && <p className="fs-address">{text(doc.site_address)}</p>}
        {start && end && (
          <p className="muted">
            {dayLabel(dayOf(Date.parse(start), ctx.zone))}, {clock(Date.parse(start), ctx.zone)}–{clock(Date.parse(end), ctx.zone)} ({span(Math.max(0, Date.parse(end) - Date.parse(start)))})
          </p>
        )}
        {(maps || tel) && (
          <div className="fs-stop-links">
            {maps && (
              <a className="btn btn-default" href={maps} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={15} /> Directions
              </a>
            )}
            {tel && (
              <a className="btn btn-default" href={tel}>
                <Icon name="user" size={15} /> Call{text(doc.contact_name) ? ` ${text(doc.contact_name)!.split(" ")[0]}` : ""}
              </a>
            )}
          </div>
        )}
        {(equipment || text(doc.serial_no)) && (
          <p>
            <span className="faint">Equipment </span>
            {[equipment, text(doc.serial_no) && `serial ${text(doc.serial_no)}`].filter(Boolean).join(", ")}
            {doc.under_warranty === true && (
              <>
                {" "}
                <Badge tone="blue">Under warranty</Badge>
              </>
            )}
          </p>
        )}
        {text(doc.description) && (
          <div>
            <h2 className="fs-sec-h">The problem</h2>
            <p className="fs-pre">{text(doc.description)}</p>
          </div>
        )}
      </section>

      <Checklist ctx={ctx} />
      <Parts ctx={ctx} />
      <Time ctx={ctx} />
      <Expenses ctx={ctx} />
      <Photos ctx={ctx} />
      <Signoff ctx={ctx} />

      {/* The one step the job offers next, always in reach. */}
      <div className="fs-bar" role="region" aria-label="Next step">
        {step ? (
          <>
            <div className="fs-bar-text">
              {step.action === "complete" && left.length > 0 ? (
                <>
                  <strong>Still to do</strong>
                  <span className="fs-bar-gaps">
                    {left.map((g) => (
                      <button key={g.text} type="button" className="link-btn" onClick={() => jump(g.section)}>
                        {g.text}
                      </button>
                    ))}
                  </span>
                </>
              ) : (
                <strong>{step.action === "complete" ? "Everything is in" : status === "Dispatched" ? "Ready to go" : "On your way"}</strong>
              )}
            </div>
            {status === "Dispatched" && (
              <Button size="md" disabled={!!busy} loading={busy === "arrive"} onClick={() => void go("arrive")} title="Skip the travel step: you are already there">
                Already here
              </Button>
            )}
            <Button variant="primary" size="md" disabled={!!busy && busy !== step.action} loading={busy === step.action} onClick={() => void go(step.action)}>
              {step.label}
            </Button>
          </>
        ) : (
          <>
            <div className="fs-bar-text">
              <strong>{note ?? status}</strong>
            </div>
            <Link className="btn btn-default btn-md" to="/day">
              Back to my day
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
