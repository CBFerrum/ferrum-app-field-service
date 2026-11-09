// A technician's day without a connection (Ferrum docs/offline.md). The day as last loaded, and each
// job as last opened, are cached reads: kept for the person signed in under the workspace's lease, and
// forgotten when it ends, when someone else signs in on the device, or when they are signed out
// everywhere. What the technician does offline is work not sent yet, kept for the person whatever
// the lease says: setting off and arriving; the checklist, parts, time, expenses and notes; the
// customer's signature and photos (their pictures in IndexedDB); and completing the job. It is sent
// in the order taken when the connection is back. A change goes as what it does (a row ticked, a row
// added or taken out, a field set), made again on the job as it stands then, so nobody else's change
// to it is undone. Each step carries its key to the server, which does it once however often it comes
// (an answer lost after the server did it, a reload, a second tab), and a row added carries its ref
// (`client_ref`), so it is never added twice. A step the server refuses is kept, with its pictures,
// until the technician tries it again or discards it, which is confirmed and noted on the job; until
// then the job is not completed, even after a reload.

import { cacheName, offlineEnv, pendingName, renewOfflineLease, sweep } from "@ferrum/client";

/** Whether an error means the server could not be reached (or the session ended): the day is
 *  then read from the device, and what the technician does waits. */
export function unreachable(e: unknown): boolean {
  if (e instanceof TypeError || (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"))) return true;
  const status = (e as { status?: number } | null)?.status;
  return status === 0 || status === 401 || status === 408 || (typeof status === "number" && status >= 500);
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function keep<T>(name: string | null, value: T, store: Store | undefined): boolean {
  if (!name || !store) return false;
  try {
    store.setItem(name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function kept<T>(name: string | null, store: Store | undefined): T | null {
  if (!name || !store) return null;
  try {
    const v = store.getItem(name);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

/** A day as it was loaded, with when. */
export interface KeptDay<T> {
  day: string;
  at: string;
  data: T;
}

/** Keeps the day for when there is no connection; nothing when the lease does not let it. */
export function keepDay<T>(day: string, data: T, store = storage(), now = new Date()): boolean {
  return keep(cacheName(offlineEnv(), "field-service", `day.${day}`), { day, at: now.toISOString(), data } satisfies KeptDay<T>, store);
}

/** The day as last loaded on this device, if the lease still covers it. */
export function keptDay<T>(day: string, store = storage()): KeptDay<T> | null {
  return kept<KeptDay<T>>(cacheName(offlineEnv(), "field-service", `day.${day}`), store);
}

/** A job as it was last opened, with when. */
export interface KeptJob<T> {
  at: string;
  data: T;
}

export function keepJob<T>(id: string, data: T, store = storage(), now = new Date()): boolean {
  return keep(cacheName(offlineEnv(), "field-service", `job.${id}`), { at: now.toISOString(), data } satisfies KeptJob<T>, store);
}

/** The job as last opened on this device, if the lease still covers it. */
export function keptJob<T>(id: string, store = storage()): KeptJob<T> | null {
  return kept<KeptJob<T>>(cacheName(offlineEnv(), "field-service", `job.${id}`), store);
}

/** What the job page needs besides the job, as the server last said it: whether the person may
 *  change jobs, the kinds of expense, their time zone, and whether they plan, work, or both. */
export interface PageFacts {
  write: boolean;
  expenseTypes: string[];
  zone: string;
  plans: boolean;
  works: boolean;
}

export function keepPage(facts: PageFacts, store = storage()): boolean {
  return keep(cacheName(offlineEnv(), "field-service", "page"), facts, store);
}

export function keptPage(store = storage()): PageFacts | null {
  return kept<PageFacts>(cacheName(offlineEnv(), "field-service", "page"), store);
}

/** What the settings ask of a job before it is completed, as last read (and returned). */
export function keepRules<T>(rules: T, store = storage()): T {
  keep(cacheName(offlineEnv(), "field-service", "rules"), rules, store);
  return rules;
}

export function keptRules<T>(store = storage()): T | null {
  return kept<T>(cacheName(offlineEnv(), "field-service", "rules"), store);
}

// ───────────────────────────── changes, as what they do ─────────────────────────────

export const TABLES = ["parts", "labour", "expenses"] as const;
export type Table = (typeof TABLES)[number];
type Row = Record<string, unknown> & { id?: string };
type Job = Record<string, unknown>;

/** What a change does, so it can be made again on the job as it stands later. An added row has the
 *  `ref` (`new-…`) the page shows it under until the server gives it an id, and goes with it as its
 *  `client_ref`; a row taken out is named by its id or, added here, by that ref. */
export type Edit =
  | { kind: "tick"; row: string; done: boolean }
  | { kind: "add"; table: Table; row: Row; ref: string }
  | { kind: "remove"; table: Table; row: string }
  | { kind: "set"; field: string; value: unknown };

const rows = (job: Job | undefined, table: string): Row[] => (Array.isArray(job?.[table]) ? (job![table] as Row[]) : []);
const idOf = (r: Row) => (typeof r.id === "string" ? r.id : null);

/** The edits a save makes: `fields` as the page sends them (a table's rows replace its rows: the
 *  ones kept by id, a new one whole), `shown` as it shows them, against the job `before` it. */
export function edits(before: Job, fields: Record<string, unknown>, shown: Record<string, unknown> = fields): Edit[] {
  const out: Edit[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (field === "checklist" && Array.isArray(value)) {
      const was = new Map(rows(before, "checklist").map((r) => [idOf(r), !!r.done]));
      for (const r of value as Row[]) {
        const id = idOf(r);
        if (id && was.has(id) && was.get(id) !== !!r.done) out.push({ kind: "tick", row: id, done: !!r.done });
      }
    } else if ((TABLES as readonly string[]).includes(field) && Array.isArray(value)) {
      const table = field as Table;
      const had = rows(before, table).map(idOf).filter((x): x is string => !!x);
      const kept = new Set((value as Row[]).map(idOf).filter((x): x is string => !!x));
      // New rows have no id in what is sent; the page shows each under a `new-…` ref.
      const refs = rows(shown, table).map(idOf).filter((x): x is string => !!x && !had.includes(x));
      let n = 0;
      for (const r of value as Row[]) {
        if (idOf(r)) continue;
        const ref = refs[n++] ?? `new-${Date.now()}-${n}`;
        out.push({ kind: "add", table, row: { ...r, client_ref: ref }, ref });
      }
      for (const id of had) if (!kept.has(id)) out.push({ kind: "remove", table, row: id });
    } else {
      out.push({ kind: "set", field, value });
    }
  }
  return out;
}

/** `fields` as the page sends them, each new row with its ref (`client_ref`) from `list`, so that
 *  sent again after an answer was lost it is not added twice. */
export function withRefs(fields: Record<string, unknown>, list: Edit[]): Record<string, unknown> {
  const out = { ...fields };
  for (const table of TABLES) {
    if (!Array.isArray(out[table])) continue;
    const refs = list.filter((e): e is Extract<Edit, { kind: "add" }> => e.kind === "add" && e.table === table).map((e) => e.ref);
    let n = 0;
    out[table] = (out[table] as Row[]).map((r) => (idOf(r) ? r : { ...r, client_ref: refs[n++] }));
  }
  return out;
}

/** What an action's key is bound to: the step and when it was taken, whatever else its body carries. */
export const actionDigest = (action: string, at: string) => `${action}@${at}`;

/** The fields to send for `list` on the job as it stands now (by id, so rows someone else added
 *  stay); null when nothing is left to change. A row already on the job under its ref is not added
 *  again, and one taken out by its ref is found by it. */
export function patchFor(job: Job, list: Edit[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const tables = new Map<string, Row[]>();
  const table = (name: string) => tables.get(name) ?? rows(job, name).map((r) => ({ id: r.id, done: r.done, client_ref: r.client_ref }));
  let changed = false;
  for (const e of list) {
    if (e.kind === "tick") {
      const list = table("checklist");
      if (!list.some((r) => r.id === e.row)) continue;
      tables.set("checklist", list.map((r) => (r.id === e.row ? { ...r, done: e.done } : r)));
      changed = true;
    } else if (e.kind === "add") {
      if (table(e.table).some((r) => r.client_ref === e.ref)) continue;
      tables.set(e.table, [...table(e.table), e.row]);
      changed = true;
    } else if (e.kind === "remove") {
      const list = table(e.table);
      const gone = (r: Row) => r.id === e.row || (r.client_ref !== undefined && r.client_ref === e.row);
      if (!list.some(gone)) continue;
      tables.set(e.table, list.filter((r) => !gone(r)));
      changed = true;
    } else {
      out[e.field] = e.value;
      changed = true;
    }
  }
  for (const [name, list] of tables) out[name] = name === "checklist" ? list.map((r) => ({ id: r.id, done: !!r.done })) : list.map((r) => (r.id ? { id: r.id } : r));
  return changed ? out : null;
}

// ───────────────────────────── what waits ─────────────────────────────

/** A step taken offline, waiting to be sent. */
export type Waiting = {
  /** Its key at the server: the same on every try, so it is done once. */
  key: string;
  work_order: string;
  /** When it was taken. */
  at: string;
  /** What it was, as the technician read it. */
  label: string;
  /** Sent at least once: the server may have done it, though no answer came. */
  tried?: boolean;
} & (
  | { action: "start_travel" | "arrive" | "complete" }
  | { action: "save"; edits: Edit[] }
  /** The signature's picture waits in IndexedDB under `blob`. */
  | { action: "sign"; blob: string; signed_by: string }
  | { action: "photo"; blob: string; file_name: string }
  /** A note on the job, such as a step discarded here and why. */
  | { action: "note"; text: string }
);

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What `hold` takes: a step without its key. */
export type Step = Without<Waiting, "key">;

const outboxName = () => pendingName(offlineEnv(), "field-service", "outbox");

export function waiting(store = storage()): Waiting[] {
  const v = kept<unknown>(outboxName(), store);
  return Array.isArray(v) ? (v as Waiting[]).filter((w) => typeof w?.key === "string" && typeof w.work_order === "string") : [];
}

function save(list: Waiting[], store = storage()): boolean {
  const name = outboxName();
  if (!name || !store) return false;
  try {
    if (list.length) store.setItem(name, JSON.stringify(list));
    else store.removeItem(name);
    return true;
  } catch {
    return false;
  }
}

let seq = 0;

/** A key no other step of this person on any device has: the job, the step, when, and chance. */
export function stepKey(w: Pick<Waiting, "work_order" | "action" | "at">): string {
  return `${w.work_order}.${w.action}.${w.at}.${++seq}.${Math.random().toString(36).slice(2, 10)}`;
}

/** Keeps a step to send later; false when the device cannot keep it (then it was not taken). A step
 *  tried already and kept because no answer came keeps its key (`key`), so the server knows it. */
export function hold(w: Step & { key?: string }, store = storage()): boolean {
  return save([...waiting(store), { ...w, key: w.key ?? stepKey(w) } as Waiting], store);
}

/** A row added offline and taken out again before it was sent: the add goes, and nothing is sent
 *  for either. True when it was such a row. Not when its step was tried: the server may hold the
 *  row, so taking it out is sent too, by its ref. */
export function forgetAdd(ref: string, store = storage()): boolean {
  let found = false;
  const list = waiting(store)
    .map((w) => {
      if (w.action !== "save" || w.tried) return w;
      const left = w.edits.filter((e) => !(e.kind === "add" && e.ref === ref));
      found ||= left.length !== w.edits.length;
      return { ...w, edits: left };
    })
    .filter((w) => w.action !== "save" || w.edits.length > 0);
  return found && save(list, store);
}

// ───────────────────────────── what the server refused ─────────────────────────────

/** A step the server refused, kept with its pictures until the technician tries it again or
 *  discards it. Its job is not completed meanwhile. */
export interface Refusal {
  step: Waiting;
  reason: string;
  /** When it was refused. */
  at: string;
}

const refusedName = () => pendingName(offlineEnv(), "field-service", "refused");

export function refusals(store = storage()): Refusal[] {
  const v = kept<unknown>(refusedName(), store);
  return Array.isArray(v) ? (v as Refusal[]).filter((r) => typeof r?.step?.key === "string" && typeof r.reason === "string") : [];
}

function keepRefusals(list: Refusal[], store = storage()): boolean {
  const name = refusedName();
  if (!name || !store) return false;
  try {
    if (list.length) store.setItem(name, JSON.stringify(list));
    else store.removeItem(name);
    return true;
  } catch {
    return false;
  }
}

/** Puts a refused step back at the front of what waits, to be sent again (put right meanwhile, or
 *  after what was in its way changed). False when there is no such refusal or no room. */
export function retry(key: string, store = storage()): boolean {
  const r = refusals(store).find((x) => x.step.key === key);
  if (!r) return false;
  // Before anything of its job still waiting, so its job's completion comes after it.
  const list = waiting(store);
  const at = list.findIndex((w) => w.work_order === r.step.work_order);
  const next = at < 0 ? [...list, r.step] : [...list.slice(0, at), r.step, ...list.slice(at)];
  return save(next, store) && keepRefusals(refusals(store).filter((x) => x.step.key !== key), store);
}

/** What a refused step was, to save outside the app before it is discarded (its picture apart). */
export function exported(r: Refusal): string {
  return JSON.stringify({ app: "field-service", refused_at: r.at, reason: r.reason, step: r.step }, null, 2);
}

/** Discards a refused step, as the technician confirmed: it and its picture go, and a note saying
 *  what was discarded and why waits to be sent to the job. False when it cannot be done. */
export async function discard(key: string, by: string, store = storage(), blobs: Blobs | null = null, now = new Date()): Promise<boolean> {
  const r = refusals(store).find((x) => x.step.key === key);
  if (!r) return false;
  const text = `Discarded on ${by}'s phone: ${r.step.label}, taken ${r.step.at}. The server had refused it: ${r.reason}`;
  if (!hold({ work_order: r.step.work_order, action: "note", text, at: now.toISOString(), label: `Note: ${r.step.label}` }, store)) return false;
  if (!keepRefusals(refusals(store).filter((x) => x.step.key !== key), store)) return false;
  if ((r.step.action === "sign" || r.step.action === "photo") && blobs) await blobs.del(r.step.blob).catch(() => undefined);
  return true;
}

const STATUS: Partial<Record<Waiting["action"], string>> = { start_travel: "En Route", arrive: "On Site", complete: "Completed" };

/** The job as the technician left it: `job` with the steps held for it made on it (rows added show
 *  under their ref; a held signature as `held:<blob>`). */
export function applied<T extends Job>(job: T, steps: Waiting[]): T {
  let out: Job = { ...job };
  for (const w of steps) {
    if (w.work_order !== job.id) continue;
    if (STATUS[w.action]) out.status = STATUS[w.action];
    if (w.action === "sign") out = { ...out, customer_signature: `held:${w.blob}`, signed_by: w.signed_by, signed_at: w.at };
    if (w.action !== "save") continue;
    for (const e of w.edits) {
      if (e.kind === "tick") out.checklist = rows(out, "checklist").map((r) => (r.id === e.row ? { ...r, done: e.done } : r));
      else if (e.kind === "add") out[e.table] = [...rows(out, e.table), { ...e.row, id: e.ref }];
      else if (e.kind === "remove") out[e.table] = rows(out, e.table).filter((r) => r.id !== e.row);
      else out[e.field] = e.value;
    }
  }
  return out as T;
}

// ───────────────────────────── pictures waiting ─────────────────────────────

/** Where pictures wait to be sent: IndexedDB in a page, memory in tests. */
export interface Blobs {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | undefined>;
  del(key: string): Promise<void>;
}

export function memoryBlobs(): Blobs {
  const m = new Map<string, Blob>();
  return { put: async (k, b) => void m.set(k, b), get: async (k) => m.get(k), del: async (k) => void m.delete(k) };
}

/** The person's pictures waiting to be sent, in an IndexedDB database under their pending name, so
 *  `sweep` never forgets them; null where nothing can be kept. */
export function blobStore(): Blobs | null {
  const name = pendingName(offlineEnv(), "field-service", "pictures");
  if (!name || typeof indexedDB === "undefined") return null;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("pictures");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction("pictures", mode);
        const req = f(t.objectStore("pictures"));
        t.oncomplete = () => resolve(req.result as T);
        t.onerror = t.onabort = () => reject(t.error ?? req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    put: (k, b) => run<void>("readwrite", (s) => s.put(b, k)),
    get: (k) => run<Blob | undefined>("readonly", (s) => s.get(k)),
    del: (k) => run<void>("readwrite", (s) => s.delete(k)),
  };
}

// ───────────────────────────── sending ─────────────────────────────

export interface Sent {
  sent: Waiting[];
  refused: { step: Waiting; reason: string }[];
  /** Completing a job one of whose steps was refused and not yet put right: not sent, and still
   *  waiting, until that step is tried again or discarded. */
  blocked: Waiting[];
}

/** Sends what waits, in the order taken, with steps taken meanwhile. Stops at the first that cannot
 *  reach the server (it and the rest wait on). One the server refuses is kept with its reason and its
 *  pictures (`refusals`), and completing its job waits until it is resolved, whatever reloads happen
 *  meanwhile. Pictures go from `blobs` once their step is sent. */
export async function send(run: (w: Waiting) => Promise<unknown>, explain: (e: unknown) => string, store = storage(), blobs: Blobs | null = null, now = () => new Date()): Promise<Sent> {
  const out: Sent = { sent: [], refused: [], blocked: [] };
  const passed = new Set<string>();
  for (;;) {
    const unresolved = new Set(refusals(store).map((r) => r.step.work_order));
    const step = waiting(store).find((w) => !passed.has(w.key));
    if (!step) break;
    const { key } = step;
    if (step.action === "complete" && unresolved.has(step.work_order)) {
      passed.add(key);
      out.blocked.push(step);
      continue;
    }
    // Marked before it goes: if no answer comes, the server may have done it.
    if (!step.tried && !save(waiting(store).map((w) => (w.key === key ? { ...w, tried: true } : w)), store)) break;
    let refused = false;
    try {
      await run({ ...step, tried: true });
      out.sent.push(step);
    } catch (e) {
      if (unreachable(e)) break;
      const reason = explain(e);
      // Kept for the technician, before it leaves what waits; a repeat replaces it.
      const kept = [...refusals(store).filter((r) => r.step.key !== key), { step: { ...step, tried: true }, reason, at: now().toISOString() }];
      if (!keepRefusals(kept, store)) break;
      out.refused.push({ step, reason });
      refused = true;
    }
    if (!refused && (step.action === "sign" || step.action === "photo") && blobs) await blobs.del(step.blob).catch(() => undefined);
    // Only this step goes: one taken while it was sent waits behind the rest.
    if (!save(waiting(store).filter((w) => w.key !== key), store)) break;
  }
  return out;
}

/** At start: forgets what the lease no longer covers, then renews it every hour while open. */
export function keepToTheLease(every = 3_600_000): () => void {
  const forget = () => void sweep(offlineEnv(), typeof indexedDB === "undefined" ? undefined : indexedDB);
  forget();
  const timer = setInterval(() => void renewOfflineLease().then(forget), every);
  return () => clearInterval(timer);
}
