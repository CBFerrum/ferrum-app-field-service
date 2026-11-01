// A work order, whole, for the office: where it is on its way, how its service level stands, who
// and where it is for, what was done on which visits, what it cost against what it bills, and the
// invoice. Only the steps the job can take are offered. The checklist, parts, time and sign-off are
// the same ones the technician fills in.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useState } from "react";
import { Link } from "react-router";
import { api, docPath, formatDecimal, formatDate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Dialog, Field, Icon, PageLoading, statusTone, TabPanel, Tabs, toast, useLiveEntity } from "@ferrum/kit";
import { can, CollabPanel, type EntityMeta, LinkTitle, RecordFields, useMetaIndex } from "@ferrum/records";
import { reason } from "./api";
import { billed, costs, history, hoursText, type InvoiceItem, margin, steps } from "./job";
import { Refusals, type View } from "./JobSheet";
import { Photos, Signoff } from "./Proof";
import { Checklist, Expenses, Parts, Time } from "./Sections";
import { slaChip, slaClocks } from "./sla";
import { priorityTone, tone } from "./status";
import { clock, dayLabel, dayOf, stamp } from "./time";

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

interface VisitRow {
  id: string;
  number?: string | null;
  status?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
}

function CancelDialog({ onClose, onCancel }: { onClose: () => void; onCancel: (why: string) => Promise<void> }) {
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onCancel(why.trim());
    setBusy(false);
  };
  return (
    <Dialog open onClose={onClose} title="Cancel this work order?">
      <form className="stack" onSubmit={submit}>
        <p className="muted">Its open visits are cancelled and the technicians' time is freed. A cancelled work order is final: new work needs a new one.</p>
        <Field label="Why" htmlFor="cancel-why" hint="Kept on the work order.">
          <textarea id="cancel-why" className="textarea" rows={3} maxLength={2000} value={why} onChange={(e) => setWhy(e.target.value)} />
        </Field>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button onClick={onClose}>Keep it</Button>
          <Button type="submit" variant="danger" loading={busy}>
            Cancel the work order
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function Cockpit({ v, meta }: { v: View; meta: EntityMeta }) {
  const { ctx } = v;
  const { doc, id, zone } = ctx;
  const qc = useQueryClient();
  const index = useMetaIndex().data;
  const [tab, setTab] = useState<"job" | "discussion">("job");
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const status = String(doc.status ?? "");
  const submitted = Number(doc.docstatus ?? 0) === 1;
  const cancelled = status === "Cancelled";
  const canWrite = can(meta.permissions, "write");
  const canInvoice = index?.entities.find((e) => e.name === "SalesInvoice")?.permissions.create !== "none" && !!index?.entities.some((e) => e.name === "SalesInvoice");
  const equipmentId = text(doc.equipment);
  const invoiceId = text(doc.sales_invoice);
  const requestId = text(doc.service_request);
  const titles = (doc._titles ?? {}) as Record<string, string>;

  const visits = useQuery({
    queryKey: ["fs", "visits", id],
    queryFn: ({ signal }) =>
      api
        .get<{ rows: VisitRow[] }>("/api/v1/ServiceAppointment", { filters: JSON.stringify([["work_order", "=", id]]), fields: "number,status,scheduled_start,scheduled_end,actual_start,actual_end", sort: "scheduled_start asc", limit: 50 }, signal)
        .then((r) => r.rows),
  });
  useLiveEntity("ServiceAppointment", useCallback(() => void qc.invalidateQueries({ queryKey: ["fs", "visits", id] }), [qc, id]));
  const equipment = useQuery({
    queryKey: ["fs", "equipment", equipmentId],
    enabled: !!equipmentId,
    staleTime: 60_000,
    queryFn: ({ signal }) => api.get<Record<string, unknown>>(docPath("CustomerEquipment", equipmentId!), { titles: false }, signal),
  });
  const earlier = useQuery({
    queryKey: ["fs", "earlier", equipmentId, id],
    enabled: !!equipmentId,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      api
        .get<{ rows: Record<string, unknown>[] }>(
          "/api/v1/ServiceWorkOrder",
          { filters: JSON.stringify([["equipment", "=", equipmentId], ["id", "!=", id]]), fields: "number,work_type,status,reported_at,completed_at,description", sort: "reported_at desc", limit: 5 },
          signal,
        )
        .then((r) => r.rows),
  });
  const invoice = useQuery({
    queryKey: ["fs", "invoice", invoiceId],
    enabled: !!invoiceId,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => api.get<Record<string, unknown>>(docPath("SalesInvoice", invoiceId!), { titles: true }, signal),
  });

  const sla = slaChip({ ...doc } as Parameters<typeof slaChip>[0], v.now, zone);
  const clocks = slaClocks({ ...doc } as Parameters<typeof slaClocks>[0], v.now);
  const { steps: stages } = steps(status);
  const money = costs(doc as Parameters<typeof costs>[0]);
  const items = (Array.isArray(invoice.data?.items) ? invoice.data!.items : []) as InvoiceItem[];
  const lines = billed(items);
  const billedTotal = text(invoice.data?.net_total) ?? text(invoice.data?.grand_total);
  const difference = margin(billedTotal, money.cost);
  const events = history(doc as Parameters<typeof history>[0]);
  const day = text(doc.scheduled_start) ? dayOf(Date.parse(String(doc.scheduled_start)), zone) : text(doc.preferred_start) ? dayOf(Date.parse(String(doc.preferred_start)), zone) : "";
  const board = `/dispatch?job=${id}${day ? `&day=${day}` : ""}`;

  const act = async (action: string, done: string, body?: unknown) => {
    setBusy(action);
    const out = await v.run(action, body);
    setBusy(null);
    if (!out.ok) {
      v.setRefused(out.fields);
      toast(out.message ?? "That did not work.", "error");
      return false;
    }
    v.setRefused([]);
    toast(done);
    return true;
  };
  const complete = async () => {
    const ok = await confirmDialog({ title: "Complete this work order?", message: "The parts leave stock and the work order is locked.", confirmLabel: "Complete" });
    if (ok) await act("complete", "The work order is completed.");
  };
  const cancel = async (why: string) => {
    if (await act("cancel_work_order", "The work order is cancelled.", { reason: why || undefined })) setCancelling(false);
  };
  const invoiceNow = async () => {
    setBusy("create_invoice");
    const out = await v.run("create_invoice");
    setBusy(null);
    if (!out.ok) return toast(out.message ?? "That did not work.", "error");
    toast("The invoice is made as a draft.");
  };
  const trackingLink = async () => {
    if (!requestId) return;
    setBusy("track");
    try {
      const made = await api.post<{ url?: string | null; path: string }>(docPath("ServiceRequest", requestId, "actions", "tracking_link"), {});
      const url = made.url ?? new URL(made.path, window.location.origin).toString();
      try {
        await navigator.clipboard.writeText(url);
        toast("The tracking link is copied.");
      } catch {
        setLink(url);
      }
    } catch (e) {
      toast(reason(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fs-page fs-cockpit">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/e/ServiceWorkOrder">Work orders</Link>
        <Icon name="chevronRight" size={12} />
      </nav>
      <header className="fs-co-head">
        <div className="fs-co-title">
          <h1 className="page-title">
            {text(doc.number)} · {text(doc.customer_name) ?? "Customer"}
          </h1>
          <p className="page-sub">
            {[text(doc.work_type), text(doc.priority) && `${doc.priority} priority`, text(doc.reported_at) && `reported ${stamp(Date.parse(String(doc.reported_at)), zone)}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={tone(status)}>{status}</Badge>
          {text(doc.priority) && doc.priority !== "Medium" && doc.priority !== "Low" && <Badge tone={priorityTone(String(doc.priority))}>{String(doc.priority)}</Badge>}
          {!cancelled && !submitted && ["New", "Scheduled", "Dispatched"].includes(status) && (
            <Link className={`btn btn-md ${status === "New" ? "btn-primary" : "btn-default"}`} to={board}>
              {status === "New" ? "Schedule on the board" : "Move on the board"}
            </Link>
          )}
          {status === "Scheduled" && canWrite && (
            <Button variant="primary" loading={busy === "dispatch"} onClick={() => void act("dispatch", "Dispatched. The technician is told.")}>
              Dispatch
            </Button>
          )}
          {status === "On Site" && (
            <Button variant="primary" loading={busy === "complete"} onClick={() => void complete()}>
              Complete
            </Button>
          )}
          {status === "Completed" && !invoiceId && canInvoice && (
            <Button variant="primary" icon="file" loading={busy === "create_invoice"} onClick={() => void invoiceNow()}>
              Create the invoice
            </Button>
          )}
          {!cancelled && !submitted && canWrite && (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Cancel
            </Button>
          )}
          {v.switch && (
            <Link className="icon-btn" to="?as=field" title="Open it as the technician sees it" aria-label="Open it as the technician sees it">
              <Icon name="user" size={15} />
            </Link>
          )}
          <Link className="icon-btn" to={`/e/ServiceWorkOrder/${id}`} title="Open the full form" aria-label="Open the full form">
            <Icon name="expand" size={15} />
          </Link>
        </div>
      </header>

      <ol className="fs-steps" aria-label="Where the work order is">
        {stages.map((s) => (
          <li key={s.name} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
            {s.name}
          </li>
        ))}
      </ol>
      {cancelled && (
        <Alert tone="error">
          Cancelled{text(doc.cancelled_at) ? ` ${stamp(Date.parse(String(doc.cancelled_at)), zone)}` : ""}
          {text(doc.cancellation_reason) ? `: ${text(doc.cancellation_reason)}` : "."}
        </Alert>
      )}
      <Refusals list={ctx.refused} />

      <div className="fs-co-body">
        <section className="fs-co-main" aria-label="The work order">
          <Tabs
            id="wo"
            tabs={[
              { id: "job", label: "The job" },
              { id: "discussion", label: "Discussion" },
            ]}
            value={tab}
            onChange={(t) => setTab(t as "job" | "discussion")}
          />
          <TabPanel id="wo" tab={tab}>
          {tab === "discussion" ? (
            <CollabPanel entity="ServiceWorkOrder" id={id} canWrite={canWrite} />
          ) : (
            <div className="fs-co-job">
              {(clocks.length > 0 || sla) && (
                <section className="fs-card-box" aria-label="Service level">
                  <h2 className="fs-sec-h">
                    Service level{" "}
                    {sla && (
                      <Badge tone={sla.tone} title={sla.title}>
                        {sla.text}
                      </Badge>
                    )}
                  </h2>
                  <ul className="fs-clocks">
                    {clocks.map((c) => (
                      <li key={c.label} data-state={c.state}>
                        <span className="faint">{c.label}</span> <strong>{stamp(c.due, zone)}</strong>
                        <span className="fs-clock-text">{c.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="fs-card-box" aria-label="Customer, site and equipment">
                <h2 className="fs-sec-h">Customer and site</h2>
                <dl className="fs-facts">
                  <dt>Customer</dt>
                  <dd>{text(doc.customer) ? <LinkTitle to="Customer" id={String(doc.customer)} title={titles.customer} /> : "—"}</dd>
                  {(text(doc.contact_name) || text(doc.contact_phone) || text(doc.contact_email)) && (
                    <>
                      <dt>Contact</dt>
                      <dd>
                        {[text(doc.contact_name), text(doc.contact_phone) && <a key="p" href={`tel:${String(doc.contact_phone).replace(/[^\d+]/g, "")}`}>{String(doc.contact_phone)}</a>, text(doc.contact_email) && <a key="e" href={`mailto:${String(doc.contact_email)}`}>{String(doc.contact_email)}</a>]
                          .filter(Boolean)
                          .map((x, i) => (
                            <span key={i}>
                              {i ? " · " : ""}
                              {x}
                            </span>
                          ))}
                      </dd>
                    </>
                  )}
                  {text(doc.site_address) && (
                    <>
                      <dt>Site</dt>
                      <dd className="fs-pre">
                        {text(doc.site_address)}
                        {titles.territory ? `\n${titles.territory}` : ""}
                      </dd>
                    </>
                  )}
                  {equipmentId && (
                    <>
                      <dt>Equipment</dt>
                      <dd>
                        <LinkTitle to="CustomerEquipment" id={equipmentId} title={titles.equipment} />
                        {text(doc.serial_no) && <span className="faint"> · serial {text(doc.serial_no)}</span>}
                        {equipment.data && (
                          <p className="faint">
                            {[text(equipment.data.warranty_end) && `warranty until ${formatDate(equipment.data.warranty_end)}`, text(equipment.data.last_service_date) && `last serviced ${formatDate(equipment.data.last_service_date)}`].filter(Boolean).join(" · ")}
                          </p>
                        )}
                      </dd>
                    </>
                  )}
                  {text(doc.description) && (
                    <>
                      <dt>Problem</dt>
                      <dd className="fs-pre">{text(doc.description)}</dd>
                    </>
                  )}
                  {Array.isArray(doc.required_skills) && doc.required_skills.length > 0 && (
                    <>
                      <dt>Needs</dt>
                      <dd>{(doc.required_skills as { skill?: string; _titles?: Record<string, string> }[]).map((r) => r._titles?.skill ?? r.skill).join(", ")}</dd>
                    </>
                  )}
                </dl>
                <div className="fs-badges">
                  {doc.under_warranty === true && <Badge tone="blue">Under warranty</Badge>}
                  {text(doc.service_contract) && (
                    <Badge tone="purple">
                      <Link to={`/e/ServiceContract/${String(doc.service_contract)}`}>Contract {titles.service_contract ?? ""}</Link>
                    </Badge>
                  )}
                  {doc.parts_covered === true && <Badge tone="green">Parts are free</Badge>}
                  {doc.labour_covered === true && <Badge tone="green">Labour is free</Badge>}
                </div>
              </section>

              <section className="fs-card-box" aria-label="Visits">
                <h2 className="fs-sec-h">Visits</h2>
                {visits.isPending ? (
                  <PageLoading label="Loading the visits" />
                ) : visits.error ? (
                  <p className="muted">The visits could not be loaded.</p>
                ) : visits.data.length ? (
                  <ul className="fs-visits">
                    {visits.data.map((a) => (
                      <li key={a.id} data-status={a.status?.toLowerCase().replace(/\s+/g, "-")}>
                        <Link to={`/e/ServiceAppointment/${a.id}`}>{a.number}</Link>
                        <Badge tone={tone(a.status ?? "")}>{a.status}</Badge>
                        <span>
                          {a.scheduled_start && a.scheduled_end
                            ? `${dayLabel(dayOf(Date.parse(a.scheduled_start), zone))}, ${clock(Date.parse(a.scheduled_start), zone)}–${clock(Date.parse(a.scheduled_end), zone)}`
                            : ""}
                        </span>
                        {a.actual_start && (
                          <span className="faint">
                            on site {clock(Date.parse(a.actual_start), zone)}
                            {a.actual_end ? `–${clock(Date.parse(a.actual_end), zone)}` : ""}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Not scheduled yet.</p>
                )}
                {Array.isArray(doc.crew) && doc.crew.length > 0 && (
                  <p className="muted">Crew: {(doc.crew as { technician_name?: string }[]).map((c) => c.technician_name).filter(Boolean).join(", ")}</p>
                )}
                <ol className="fs-history" aria-label="What happened">
                  {events.map((e) => (
                    <li key={e.text + e.at}>
                      <time className="faint">{stamp(e.at, zone)}</time> {e.text}
                    </li>
                  ))}
                </ol>
              </section>

              <Checklist ctx={ctx} />
              <Photos ctx={ctx} />
              <Parts ctx={ctx} />
              <Time ctx={ctx} />
              <Expenses ctx={ctx} />
              <Signoff ctx={ctx} />

              <section className="fs-card-box" aria-label="Cost against billable">
                <h2 className="fs-sec-h">Cost and bill</h2>
                <div className="fs-money">
                  <dl className="fs-facts">
                    <dt>Billable time</dt>
                    <dd>{hoursText(doc.billable_hours as string)} h of {hoursText(doc.labour_hours as string)} h{doc.labour_covered === true ? " (free: covered)" : ""}</dd>
                    <dt>Expenses</dt>
                    <dd>{formatDecimal(money.expenses, 2)}</dd>
                    {money.cost != null && (
                      <>
                        <dt>Labour cost</dt>
                        <dd>{formatDecimal(money.labour ?? 0, 2)}</dd>
                        <dt>Parts cost</dt>
                        <dd>{formatDecimal(money.parts ?? 0, 2)}</dd>
                        <dt>It cost</dt>
                        <dd>
                          <strong>{formatDecimal(money.cost, 2)}</strong>
                        </dd>
                      </>
                    )}
                    {billedTotal != null && (
                      <>
                        <dt>Billed</dt>
                        <dd>
                          <strong>{formatDecimal(billedTotal, 2)}</strong>
                        </dd>
                      </>
                    )}
                    {difference != null && (
                      <>
                        <dt>Difference</dt>
                        <dd data-negative={difference.startsWith("-") || undefined}>{formatDecimal(difference, 2)}</dd>
                      </>
                    )}
                  </dl>
                </div>
                {money.cost == null && <p className="faint">Costs are only shown to those who may see them.</p>}
              </section>

              <section className="fs-card-box" aria-label="Invoice">
                <h2 className="fs-sec-h">Invoice</h2>
                {invoiceId ? (
                  invoice.isPending ? (
                    <PageLoading label="Loading the invoice" />
                  ) : (
                    <>
                      <p>
                        <LinkTitle to="SalesInvoice" id={invoiceId} title={titles.sales_invoice} />{" "}
                        {text(invoice.data?.status) && <Badge tone={statusTone(invoice.data?.status)}>{String(invoice.data?.status)}</Badge>}
                      </p>
                      {lines.length > 0 ? (
                        <div className="table-wrap">
                        <table className="table fs-invoice">
                          <thead>
                            <tr>
                              <th>What</th>
                              <th className="num">Qty</th>
                              <th className="num">Rate</th>
                              <th className="num">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((l, i) => (
                              <tr key={i} data-free={l.free || undefined}>
                                <td>
                                  {l.text} {l.free && <Badge tone="green">Covered</Badge>}
                                </td>
                                <td className="num">{formatDecimal(l.qty)}</td>
                                <td className="num">{formatDecimal(l.rate, 2)}</td>
                                <td className="num">{formatDecimal(l.amount, 2)}</td>
                              </tr>
                            ))}
                          </tbody>
                          {text(invoice.data?.grand_total) && (
                            <tfoot>
                              <tr>
                                <td colSpan={3}>Total</td>
                                <td className="num">{formatDecimal(invoice.data?.grand_total, 2)}</td>
                              </tr>
                            </tfoot>
                          )}
                        </table>
                        </div>
                      ) : invoice.error ? (
                        <p className="muted">The invoice's lines are not yours to see.</p>
                      ) : null}
                    </>
                  )
                ) : status === "Completed" ? (
                  <p className="muted">Not invoiced yet. The invoice is made once, with warranty and contract cover as a full discount.</p>
                ) : (
                  <p className="muted">It is invoiced once the work is completed.</p>
                )}
              </section>
            </div>
          )}
          </TabPanel>
        </section>

        <aside className="fs-co-side" aria-label="Details">
          <RecordFields meta={meta} doc={doc} save={(n, val) => ctx.save({ [n]: val }).then(() => undefined)} only={["Job", "Contact", "Planning"]} />
          {requestId && (
            <div className="fs-side-box">
              <h3>Customer tracking</h3>
              <Button size="sm" icon="copy" loading={busy === "track"} onClick={() => void trackingLink()}>
                Copy the tracking link
              </Button>
              {link && <input className="input" readOnly aria-label="Tracking link" value={link} onFocus={(e) => e.currentTarget.select()} />}
            </div>
          )}
          {equipmentId && (
            <div className="fs-side-box">
              <h3>Earlier jobs on this equipment</h3>
              {earlier.isPending ? (
                <PageLoading label="Loading" />
              ) : earlier.data?.length ? (
                <ul className="fs-earlier">
                  {earlier.data.map((e) => (
                    <li key={String(e.id)}>
                      <Link to={`/w/${String(e.id)}`}>{String(e.number)}</Link> <Badge tone={tone(String(e.status))}>{String(e.status)}</Badge>
                      <p className="faint">
                        {[text(e.work_type), text(e.completed_at) ?? text(e.reported_at) ? stamp(Date.parse(String(e.completed_at ?? e.reported_at)), zone) : null].filter(Boolean).join(" · ")}
                      </p>
                      {text(e.description) && <p className="fs-clamp-2">{text(e.description)}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None. This is its first job.</p>
              )}
            </div>
          )}
        </aside>
      </div>
      {cancelling && <CancelDialog onClose={() => setCancelling(false)} onCancel={cancel} />}
    </div>
  );
}
