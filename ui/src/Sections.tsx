// The parts of a job a technician fills in as they work it: the checklist, the parts used, the time
// spent and the expenses. Each change is saved as it is made and shows at once; the server checks
// stock, serial numbers and who may record whose time, and what it refuses is told beside the row.

import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, docPath, type FieldError, formatDecimal, t as tr, isolate } from "@ferrum/client";
import { Badge, Button, confirmDialog, Field, Icon } from "@ferrum/kit";
import { type Doc, LinkInput } from "@ferrum/records";
import { type CheckRow, elapsed, type ExpenseRow, hoursText, type LabourRow, type PartRow, progress, serialNote, serials, stopped, toggled } from "./job";
import type { Step, Waiting } from "./offline";
import { MINUTE, clock, dayLabel, dayOf, fromWallInput } from "./time";
import type { Outcome } from "./useWork";

/** What the sections share: the job, whether it can still be changed, and how to change it. */
export interface Ctx {
  id: string;
  doc: Doc;
  zone: string;
  editable: boolean;
  /** An office user records time for whoever worked the job; a technician for themselves. */
  office: boolean;
  save: (fields: Record<string, unknown>, shown?: Record<string, unknown>) => Promise<Outcome>;
  /** What the server refused when the job was last completed, row by row. */
  refused: FieldError[];
  expenseTypes: string[];
  /** Keeps a step on this phone to send when the connection is back; false when it cannot. */
  hold?: (step: Step) => boolean;
  /** Photos of this job waiting on this phone. */
  heldPhotos?: Extract<Waiting, { action: "photo" }>[];
}

export const rowsOf = <T,>(doc: Doc, table: string): T[] => (Array.isArray(doc[table]) ? (doc[table] as T[]) : []);

const refusals = (ctx: Ctx, table: string, index: number) => ctx.refused.filter((f) => f.row?.[0] === table && f.row[1] === index);

function Why({ list }: { list: FieldError[] }) {
  return list.length ? (
    <p className="field-error" role="alert">
      {isolate(list.map((f) => f.message).join(" "))}
    </p>
  ) : null;
}

/** Keeps the rows that are already there as they are (just their ids); a row added a moment ago
 *  and not yet saved goes whole, so a second change made before the first lands does not lose it. */
const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => (r.id.startsWith("new-") ? r : { id: r.id }));

// ───────────────────────────── checklist ─────────────────────────────

export function Checklist({ ctx }: { ctx: Ctx }) {
  const rows = rowsOf<CheckRow>(ctx.doc, "checklist");
  const p = progress(rows);
  const tick = (r: CheckRow) => {
    const next = toggled(rows, r.id, !r.done);
    void ctx.save({ checklist: next.map((x) => ({ id: x.id, done: !!x.done })) }, { checklist: next });
  };
  return (
    <section id="checklist" className="fs-sec" aria-labelledby="fs-h-checklist">
      <h2 id="fs-h-checklist" className="fs-sec-h">
        {tr("Checklist")} {rows.length > 0 && <span className="faint">{tr("{done} of {total} done", { done: p.done, total: p.total })}</span>}
      </h2>
      {rows.length > 0 && (
        <div className="fs-bar-track" role="progressbar" aria-label={tr("Checklist progress")} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
          <i style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
        </div>
      )}
      {rows.length ? (
        <ul className="fs-checks">
          {rows.map((r, i) => (
            <li key={r.id}>
              <label className="fs-check" data-done={r.done || undefined}>
                <input type="checkbox" checked={!!r.done} disabled={!ctx.editable} onChange={() => tick(r)} />
                <span className="fs-check-text">{isolate(r.task ?? "")}</span>
                {r.required && !r.done && <span className="fs-req">{tr("Required")}</span>}
              </label>
              <Why list={refusals(ctx, "checklist", i)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{tr("This job has no checklist.")}</p>
      )}
    </section>
  );
}

// ───────────────────────────── parts ─────────────────────────────

export function Parts({ ctx }: { ctx: Ctx }) {
  const rows = rowsOf<PartRow>(ctx.doc, "parts");
  const [adding, setAdding] = useState(false);
  const [item, setItem] = useState<{ id: string; title?: string } | null>(null);
  const [qty, setQty] = useState("1");
  const [serial, setSerial] = useState("");
  const [batch, setBatch] = useState("");
  const [warranty, setWarranty] = useState(false);
  const [busy, setBusy] = useState(false);
  const info = useQuery({ queryKey: ["fs", "item", item?.id], enabled: !!item, staleTime: 5 * 60_000, queryFn: ({ signal }) => api.get<Doc>(docPath("Item", item!.id), { titles: false }, signal) });
  const serialised = info.data?.has_serial_no === true;
  const batched = info.data?.has_batch_no === true;
  const note = serialised ? serialNote(serial, qty) : null;
  const reset = () => {
    setAdding(false);
    setItem(null);
    setQty("1");
    setSerial("");
    setBatch("");
    setWarranty(false);
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!item || !(Number(qty) > 0)) return;
    const fresh = { item: item.id, qty, warranty, ...(serialised ? { serial_no: serials(serial).join("\n") } : {}), ...(batched && batch.trim() ? { batch_no: batch.trim() } : {}) };
    setBusy(true);
    const out = await ctx.save({ parts: [...ids(rows), fresh] }, { parts: [...rows, { ...fresh, id: `new-${Date.now()}`, item_name: item.title }] });
    setBusy(false);
    if (out.ok) reset();
  };
  const remove = async (r: PartRow) => {
    const ok = await confirmDialog({ title: tr("Remove {value}?", { value: r.item_name ?? tr("this part") }), message: tr("It is taken off the job and will not leave your stock."), confirmLabel: tr("Remove"), danger: true });
    if (ok) void ctx.save({ parts: ids(rows.filter((x) => x.id !== r.id)) }, { parts: rows.filter((x) => x.id !== r.id) });
  };
  return (
    <section id="parts" className="fs-sec" aria-labelledby="fs-h-parts">
      <h2 id="fs-h-parts" className="fs-sec-h">
        {tr("Parts used")} {rows.length > 0 && <span className="faint">{rows.length}</span>}
      </h2>
      {rows.length > 0 && (
        <ul className="fs-rows">
          {rows.map((r, i) => (
            <li key={r.id} data-new={r.id.startsWith("new-") || undefined}>
              <div className="fs-row">
                <div className="fs-row-main">
                  <strong>{r.item_name || tr("Part")}</strong> <span className="faint">× {isolate(formatDecimal(r.qty))}</span>
                  {r.warranty && (
                    <>
                      {isolate(" ")}
                      <Badge tone="blue">{tr("Under warranty")}</Badge>
                    </>
                  )}
                  {serials(r.serial_no).length > 0 && <p className="faint">{tr("Serial")} {isolate(serials(r.serial_no).join(", "))}</p>}
                  {r.batch_no && <p className="faint">{tr("Batch {batch_no}", { batch_no: r.batch_no })}</p>}
                </div>
                {ctx.editable && (
                  <button type="button" className="icon-btn" aria-label={tr("Remove {value}", { value: r.item_name ?? "part" })} onClick={() => void remove(r)}>
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </div>
              <Why list={refusals(ctx, "parts", i)} />
            </li>
          ))}
        </ul>
      )}
      {!rows.length && !adding && <p className="muted">{tr("No parts yet.")}</p>}
      {ctx.editable &&
        (adding ? (
          <form className="fs-form" onSubmit={add}>
            <Field label={tr("Part")} htmlFor="part-item" required>
              <LinkInput to="Item" id="part-item" value={item?.id ?? null} title={item?.title} placeholder={tr("Search by name or code")} onChange={(id, title) => setItem(id ? { id, title } : null)} />
            </Field>
            <Field label={tr("How many")} htmlFor="part-qty" required>
              <input id="part-qty" className="input" type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            {serialised && (
              <Field label={tr("Serial numbers")} htmlFor="part-serial" hint={note ?? tr("One per line. A scanner can type them in.")}>
                <textarea id="part-serial" className="textarea" rows={3} autoCapitalize="characters" spellCheck={false} value={serial} onChange={(e) => setSerial(e.target.value)} />
              </Field>
            )}
            {batched && (
              <Field label={tr("Batch number")} htmlFor="part-batch" required>
                <input id="part-batch" className="input" value={batch} onChange={(e) => setBatch(e.target.value)} />
              </Field>
            )}
            <label className="fs-switch">
              <input type="checkbox" checked={warranty} onChange={(e) => setWarranty(e.target.checked)} />
              {tr("Replaced under warranty: no charge to the customer")}
            </label>
            <div className="fs-form-actions">
              <Button onClick={reset}>{tr("Cancel")}</Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!item || !(Number(qty) > 0)}>
                {tr("Add the part")}
              </Button>
            </div>
          </form>
        ) : (
          <Button icon="plus" onClick={() => setAdding(true)}>
            {tr("Add a part")}
          </Button>
        ))}
    </section>
  );
}

// ───────────────────────────── time ─────────────────────────────

/** A timer that keeps running while the page is closed: its start is kept on this device. */
function useTimer(id: string) {
  const key = `fs.timer.${id}`;
  const [startedAt, setStartedAt] = useState<number | null>(() => {
    try {
      const t = Date.parse(localStorage.getItem(key) ?? "");
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  const start = () => {
    const t = Date.now();
    try {
      localStorage.setItem(key, new Date(t).toISOString());
    } catch {
      // A private window forgets it when it closes; the timer then runs while the page is open.
    }
    setNow(t);
    setStartedAt(t);
  };
  const clear = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing was kept.
    }
    setStartedAt(null);
  };
  return { startedAt, now, start, clear };
}

export function Time({ ctx }: { ctx: Ctx }) {
  const rows = rowsOf<LabourRow>(ctx.doc, "labour");
  const crew = rowsOf<{ technician?: string; technician_name?: string }>(ctx.doc, "crew").filter((c) => c.technician);
  const timer = useTimer(ctx.id);
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [who, setWho] = useState("");
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const technician = ctx.office ? (who || crew[0]?.technician) : undefined;
  // The boxes show the workspace's wall clock, as the rest of the job does.
  const fromAt = fromWallInput(from, ctx.zone);
  const toAt = fromWallInput(to, ctx.zone);
  const ahead = toAt != null && toAt > Date.now() + 5 * MINUTE;
  const valid = fromAt != null && toAt != null && toAt > fromAt && !ahead && (!ctx.office || !!technician);

  const record = async (a: string, z: string, bill = true) => {
    const fresh = { from_time: a, to_time: z, billable: bill, ...(technician ? { technician } : {}) };
    return ctx.save({ labour: [...ids(rows), fresh] }, { labour: [...rows, { ...fresh, id: `new-${Date.now()}`, technician_name: crew.find((c) => c.technician === technician)?.technician_name }] });
  };
  const stop = async () => {
    if (timer.startedAt == null) return;
    const t = stopped(timer.startedAt, Date.now());
    if (!t) return timer.clear();
    setBusy(true);
    const out = await record(t.from, t.to);
    setBusy(false);
    if (out.ok) timer.clear();
  };
  const addByHand = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const out = await record(new Date(fromAt!).toISOString(), new Date(toAt!).toISOString(), billable);
    setBusy(false);
    if (out.ok) {
      setAdding(false);
      setFrom("");
      setTo("");
    }
  };
  const remove = async (r: LabourRow) => {
    const ok = await confirmDialog({ title: tr("Remove this time?"), confirmLabel: tr("Remove"), danger: true });
    if (ok) void ctx.save({ labour: ids(rows.filter((x) => x.id !== r.id)) }, { labour: rows.filter((x) => x.id !== r.id) });
  };
  const hours = rows.reduce((n, r) => n + (Number(r.hours) || 0), 0);
  const stamp = (iso?: string | null) => (iso ? `${dayLabel(dayOf(Date.parse(iso), ctx.zone))}, ${clock(Date.parse(iso), ctx.zone)}` : "");

  return (
    <section id="time" className="fs-sec" aria-labelledby="fs-h-time">
      <h2 id="fs-h-time" className="fs-sec-h">
        {tr("Time")} {rows.length > 0 && <span className="faint">{isolate(hoursText(hours))} h</span>}
      </h2>
      {ctx.editable && (
        <div className="fs-timer" data-running={timer.startedAt != null || undefined}>
          {timer.startedAt != null ? (
            <>
              <div>
                <strong className="fs-timer-clock" aria-live="off">
                  {isolate(elapsed(timer.startedAt, timer.now))}
                </strong>
                <p className="faint">{tr("Running since")} {isolate(clock(timer.startedAt, ctx.zone))}</p>
              </div>
              <Button variant="primary" loading={busy} onClick={() => void stop()}>
                {tr("Stop and save")}
              </Button>
            </>
          ) : (
            <>
              <div>
                <strong>{tr("Time on the job")}</strong>
                <p className="faint">{tr("Start when you begin work; it is saved when you stop.")}</p>
              </div>
              <Button variant="primary" icon="timeline" onClick={timer.start}>
                {tr("Start timer")}
              </Button>
            </>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="fs-rows">
          {rows.map((r, i) => (
            <li key={r.id} data-new={r.id.startsWith("new-") || undefined}>
              <div className="fs-row">
                <div className="fs-row-main">
                  <strong>{r.hours != null ? `${hoursText(r.hours)} h` : tr("Time")}</strong> {r.technician_name && <span className="faint">{isolate(r.technician_name)}</span>}
                  {r.billable === false && (
                    <>
                      {isolate(" ")}
                      <Badge>{tr("Not billed")}</Badge>
                    </>
                  )}
                  <p className="faint">
                    {isolate(stamp(r.from_time))} – {r.to_time ? clock(Date.parse(r.to_time), ctx.zone) : ""}
                  </p>
                </div>
                {ctx.editable && (
                  <button type="button" className="icon-btn" aria-label={tr("Remove this time")} onClick={() => void remove(r)}>
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </div>
              <Why list={refusals(ctx, "labour", i)} />
            </li>
          ))}
        </ul>
      )}
      {ctx.editable &&
        (adding ? (
          <form className="fs-form" onSubmit={addByHand}>
            {ctx.office && crew.length > 0 && (
              <Field label={tr("Who")} htmlFor="time-who" required>
                <select id="time-who" className="select" value={who || crew[0]?.technician} onChange={(e) => setWho(e.target.value)}>
                  {crew.map((c) => (
                    <option key={c.technician} value={c.technician}>
                      {isolate(c.technician_name ?? "")}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={tr("Started")} htmlFor="time-from" required>
              <input id="time-from" className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={tr("Finished")} htmlFor="time-to" required error={ahead ? tr("That is still to come: record time once it is worked.") : fromAt != null && toAt != null && toAt <= fromAt ? tr("Finish after the start.") : undefined}>
              <input id="time-to" className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <label className="fs-switch">
              <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
              {tr("Bill the customer for this time")}
            </label>
            <div className="fs-form-actions">
              <Button onClick={() => setAdding(false)}>{tr("Cancel")}</Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
                {tr("Add the time")}
              </Button>
            </div>
          </form>
        ) : (
          <button type="button" className="link-btn" onClick={() => setAdding(true)}>
            {tr("Forgot the timer? Add time by hand")}
          </button>
        ))}
      {!rows.length && !ctx.editable && <p className="muted">{tr("No time was recorded.")}</p>}
    </section>
  );
}

// ───────────────────────────── expenses ─────────────────────────────

const EXPENSE_TYPES = ["Travel", "Mileage", "Parking", "Tolls", "Lodging", "Meals", "Materials", "Other"];

export function Expenses({ ctx }: { ctx: Ctx }) {
  const rows = rowsOf<ExpenseRow>(ctx.doc, "expenses");
  const types = ctx.expenseTypes.length ? ctx.expenseTypes : EXPENSE_TYPES;
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const kind = type || types.at(-1) || "Other";
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!(Number(amount) > 0)) return;
    const fresh = { expense_type: kind, description: note.trim() || null, amount, billable };
    setBusy(true);
    const out = await ctx.save({ expenses: [...ids(rows), fresh] }, { expenses: [...rows, { ...fresh, id: `new-${Date.now()}` }] });
    setBusy(false);
    if (out.ok) {
      setAdding(false);
      setType("");
      setNote("");
      setAmount("");
    }
  };
  const remove = async (r: ExpenseRow) => {
    const ok = await confirmDialog({ title: tr("Remove this {value}?", { value: (r.expense_type ?? "expense").toLowerCase() }), confirmLabel: tr("Remove"), danger: true });
    if (ok) void ctx.save({ expenses: ids(rows.filter((x) => x.id !== r.id)) }, { expenses: rows.filter((x) => x.id !== r.id) });
  };
  return (
    <section id="expenses" className="fs-sec" aria-labelledby="fs-h-expenses">
      <h2 id="fs-h-expenses" className="fs-sec-h">
        {tr("Expenses")} {rows.length > 0 && <span className="faint">{isolate(formatDecimal(ctx.doc.expense_total ?? 0, 2))}</span>}
      </h2>
      {rows.length > 0 && (
        <ul className="fs-rows">
          {rows.map((r, i) => (
            <li key={r.id} data-new={r.id.startsWith("new-") || undefined}>
              <div className="fs-row">
                <div className="fs-row-main">
                  <strong>{isolate(r.expense_type ?? "")}</strong> <span className="faint">{isolate(formatDecimal(r.amount, 2))}</span>
                  {r.billable === false && (
                    <>
                      {isolate(" ")}
                      <Badge>{tr("Not billed")}</Badge>
                    </>
                  )}
                  {r.description && <p className="faint">{isolate(r.description)}</p>}
                </div>
                {ctx.editable && (
                  <button type="button" className="icon-btn" aria-label={tr("Remove {value}", { value: r.expense_type ?? "expense" })} onClick={() => void remove(r)}>
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </div>
              <Why list={refusals(ctx, "expenses", i)} />
            </li>
          ))}
        </ul>
      )}
      {!rows.length && !adding && <p className="muted">{tr("No expenses.")}</p>}
      {ctx.editable &&
        (adding ? (
          <form className="fs-form" onSubmit={add}>
            <Field label={tr("What for")} htmlFor="exp-type" required>
              <select id="exp-type" className="select" value={kind} onChange={(e) => setType(e.target.value)}>
                {types.map((t) => (
                  <option key={t}>{isolate(t)}</option>
                ))}
              </select>
            </Field>
            <Field label={tr("Amount")} htmlFor="exp-amount" required>
              <input id="exp-amount" className="input" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label={tr("Note")} htmlFor="exp-note">
              <input id="exp-note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <label className="fs-switch">
              <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
              {tr("Bill the customer for it")}
            </label>
            <div className="fs-form-actions">
              <Button onClick={() => setAdding(false)}>{tr("Cancel")}</Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!(Number(amount) > 0)}>
                {tr("Add the expense")}
              </Button>
            </div>
          </form>
        ) : (
          <Button icon="plus" onClick={() => setAdding(true)}>
            {tr("Add an expense")}
          </Button>
        ))}
    </section>
  );
}
