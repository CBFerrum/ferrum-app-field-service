// One work order's page: how far the checklist is, what stands between the job and its completion,
// where it is on its way from new to invoiced, what it cost against what it bills, and the small
// things a phone needs (a running timer, a photo made smaller, serial numbers counted). The server
// holds the rules and checks them again when the job is completed; this only says what it will ask.

import { sub, total } from "./decimal";
import { STEPS } from "./status";
import { t } from "@ferrum/client";

export interface CheckRow {
  id: string;
  task?: string | null;
  required?: boolean;
  done?: boolean;
  done_by?: string | null;
  done_at?: string | null;
  notes?: string | null;
}

export interface PartRow {
  id: string;
  item?: string | null;
  item_name?: string | null;
  qty?: string | number | null;
  uom?: string | null;
  warehouse?: string | null;
  serial_no?: string | null;
  batch_no?: string | null;
  warranty?: boolean;
  cost?: string | null;
}

export interface LabourRow {
  id: string;
  technician?: string | null;
  technician_name?: string | null;
  from_time?: string | null;
  to_time?: string | null;
  hours?: string | number | null;
  billable?: boolean;
  notes?: string | null;
}

export interface ExpenseRow {
  id: string;
  expense_type?: string | null;
  description?: string | null;
  amount?: string | number | null;
  billable?: boolean;
}

// ───────────────────────────── the checklist and completing ─────────────────────────────

export interface Progress {
  done: number;
  total: number;
  /** Tasks that must be done before the job can be completed, and how many are still open. */
  required: number;
  requiredLeft: number;
}

export function progress(rows: Pick<CheckRow, "done" | "required">[]): Progress {
  return {
    done: rows.filter((r) => r.done).length,
    total: rows.length,
    required: rows.filter((r) => r.required).length,
    requiredLeft: rows.filter((r) => r.required && !r.done).length,
  };
}

/** A task ticked or unticked, the rest untouched. */
export const toggled = <T extends { id: string; done?: boolean }>(rows: T[], id: string, done: boolean): T[] => rows.map((r) => (r.id === id ? { ...r, done } : r));

/** What the settings ask of a job before it can be completed (their defaults until a manager changes them). */
export interface Rules {
  require_checklist: boolean;
  require_signature: boolean;
}

export const DEFAULT_RULES: Rules = { require_checklist: true, require_signature: true };

export interface Gap {
  text: string;
  /** The part of the page where it is put right. */
  section: "checklist" | "signoff";
}

/** What is still missing for the job to be completed, as the server will check it. */
export function gaps(doc: { checklist?: CheckRow[] | null; customer_signature?: string | null; signed_by?: string | null }, rules: Rules): Gap[] {
  const out: Gap[] = [];
  const left = progress(doc.checklist ?? []).requiredLeft;
  if (rules.require_checklist && left) out.push({ text: (left === 1 ? t("1 required task is not done") : t("{left} required tasks are not done", { left })), section: "checklist" });
  if (rules.require_signature) {
    if (!doc.customer_signature) out.push({ text: t("The customer has not signed"), section: "signoff" });
    if (!doc.signed_by?.trim()) out.push({ text: t("Who signed is not written down"), section: "signoff" });
  }
  return out;
}

// ───────────────────────────── where the job stands ─────────────────────────────

export interface StepState {
  name: string;
  state: "done" | "current" | "todo";
}

/** The statuses a job passes through, marked by where it is; a cancelled job has passed none. */
export function steps(status: string | null | undefined): { steps: StepState[]; cancelled: boolean } {
  const at = (STEPS as readonly string[]).indexOf(status ?? "");
  const cancelled = status === "Cancelled";
  return { cancelled, steps: STEPS.map((name, i) => ({ name, state: cancelled || at < 0 ? "todo" : i < at ? "done" : i === at ? "current" : "todo" })) };
}

// ───────────────────────────── parts, time and photos ─────────────────────────────

/** Serial numbers, one per line. */
export const serials = (text: string | null | undefined): string[] =>
  (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/** How the serial numbers given compare with the quantity, for a serialised part; null when they agree. */
export function serialNote(text: string | null | undefined, qty: string | number | null | undefined): string | null {
  const have = serials(text).length;
  const want = Number(qty);
  if (!Number.isFinite(want) || want <= 0) return null;
  return have === want ? null : (want === 1 ? t("{have} of 1 serial number given", { have }) : t("{have} of {want} serial numbers given", { have, want }));
}

/** Hours the way a person says them: 1.5, not 1.50. */
export function hoursText(hours: string | number | null | undefined): string {
  const n = Number(hours);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : "0";
}

/** 83 seconds as 0:01:23. */
export function elapsed(startMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** A stopped timer as the labour to record, or why it cannot be (under a second is a double tap). */
export function stopped(startMs: number, nowMs: number): { from: string; to: string } | null {
  return nowMs - startMs >= 1000 ? { from: new Date(startMs).toISOString(), to: new Date(nowMs).toISOString() } : null;
}

/** The size a photo is drawn at so a phone sends less: within `max` pixels on its longer side, never enlarged. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const isImage = (name: string | null | undefined) => /\.(jpe?g|png|gif|webp|heic|heif|avif)$/i.test(name ?? "");

// ───────────────────────────── cost against billable ─────────────────────────────

export interface Money {
  labour: string | null;
  parts: string | null;
  expenses: string;
  /** What the job cost; null for those who may not see costs. */
  cost: string | null;
}

/** The job's cost, from the fields only those with the right to see costs are sent. */
export function costs(doc: { labour_cost?: string | null; parts_cost?: string | null; expense_total?: string | null }): Money {
  const seen = doc.labour_cost != null || doc.parts_cost != null;
  return {
    labour: doc.labour_cost ?? null,
    parts: doc.parts_cost ?? null,
    expenses: doc.expense_total ?? "0",
    cost: seen ? total([doc.labour_cost, doc.parts_cost, doc.expense_total]) : null,
  };
}

/** What the customer is billed less what the job cost: positive is margin. */
export const margin = (billed: string | null | undefined, cost: string | null) => (billed != null && cost != null ? sub(billed, cost) : null);

export interface InvoiceItem {
  description?: string | null;
  item_name?: string | null;
  qty?: string | number | null;
  rate?: string | number | null;
  price_list_rate?: string | number | null;
  discount_percent?: string | number | null;
  amount?: string | number | null;
}

export interface BilledLine {
  text: string;
  qty: string;
  rate: string;
  amount: string;
  /** Covered by warranty or a contract: a full discount. */
  free: boolean;
}

/** The invoice's lines as the customer reads them, those covered by warranty or contract marked. */
export function billed(items: InvoiceItem[]): BilledLine[] {
  return items.map((i) => ({
    text: (i.description || i.item_name || "").trim(),
    qty: String(i.qty ?? ""),
    rate: String(i.price_list_rate ?? i.rate ?? ""),
    amount: String(i.amount ?? "0"),
    free: Number(i.discount_percent ?? 0) >= 100,
  }));
}

export interface Event {
  at: number;
  text: string;
}

/** What happened to a job, from the moments the server stamps on it, oldest first. */
export function history(doc: {
  reported_at?: string | null;
  travel_started_at?: string | null;
  arrived_at?: string | null;
  signed_at?: string | null;
  signed_by?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
}): Event[] {
  const out: Event[] = [];
  const mark = (iso: string | null | undefined, text: string) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(at)) out.push({ at, text });
  };
  mark(doc.reported_at, t("Problem reported"));
  mark(doc.travel_started_at, t("Technician set off"));
  mark(doc.arrived_at, t("Technician arrived on site"));
  mark(doc.signed_at, `Signed${doc.signed_by ? t(" by {signed_by}", { signed_by: doc.signed_by }) : ""}`);
  mark(doc.completed_at, t("Job completed"));
  mark(doc.cancelled_at, t("Job cancelled"));
  return out.sort((a, b) => a.at - b.at);
}
