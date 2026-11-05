// A technician's day without a connection (Ferrum docs/offline.md). The day as last loaded is a
// cached read: kept for the person signed in under the workspace's lease, and forgotten when it
// ends, when someone else signs in on the device, or when they are signed out everywhere. Setting
// off and arriving, taken offline, are work not sent yet: kept for the person and sent, in the
// order taken, when the connection is back; one the server refuses is dropped and said why.

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

/** A day as it was loaded, with when. */
export interface KeptDay<T> {
  day: string;
  at: string;
  data: T;
}

/** Keeps the day for when there is no connection; nothing when the lease does not let it. */
export function keepDay<T>(day: string, data: T, store = storage(), now = new Date()): boolean {
  const name = cacheName(offlineEnv(), "field-service", `day.${day}`);
  if (!name || !store) return false;
  try {
    store.setItem(name, JSON.stringify({ day, at: now.toISOString(), data } satisfies KeptDay<T>));
    return true;
  } catch {
    return false;
  }
}

/** The day as last loaded on this device, if the lease still covers it. */
export function keptDay<T>(day: string, store = storage()): KeptDay<T> | null {
  const name = cacheName(offlineEnv(), "field-service", `day.${day}`);
  if (!name || !store) return null;
  try {
    const kept = store.getItem(name);
    return kept ? (JSON.parse(kept) as KeptDay<T>) : null;
  } catch {
    return null;
  }
}

/** A step taken offline, waiting to be sent. */
export interface Waiting {
  key: string;
  work_order: string;
  action: "start_travel" | "arrive";
  /** When it was taken. */
  at: string;
  /** Who it was for, as the technician read it. */
  label: string;
}

const outboxName = () => pendingName(offlineEnv(), "field-service", "outbox");

export function waiting(store = storage()): Waiting[] {
  const name = outboxName();
  if (!name || !store) return [];
  try {
    const v: unknown = JSON.parse(store.getItem(name) ?? "[]");
    return Array.isArray(v) ? (v as Waiting[]).filter((w) => typeof w?.key === "string" && typeof w.work_order === "string") : [];
  } catch {
    return [];
  }
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

/** Keeps a step to send later; false when the device cannot keep it (then it was not taken). */
export function hold(w: Omit<Waiting, "key">, store = storage()): boolean {
  return save([...waiting(store), { ...w, key: `${w.work_order}.${w.action}.${w.at}` }], store);
}

/** Sends what waits, in the order taken. Stops at the first that cannot reach the server (it and
 *  the rest wait on); one the server refuses is dropped, with its reason. */
export async function send(run: (w: Waiting) => Promise<unknown>, explain: (e: unknown) => string, store = storage()): Promise<{ sent: Waiting[]; refused: { step: Waiting; reason: string }[] }> {
  const sent: Waiting[] = [];
  const refused: { step: Waiting; reason: string }[] = [];
  let list = waiting(store);
  while (list.length) {
    const [step, ...rest] = list;
    try {
      await run(step);
      sent.push(step);
    } catch (e) {
      if (unreachable(e)) break;
      refused.push({ step, reason: explain(e) });
    }
    list = rest;
    save(list, store);
  }
  return { sent, refused };
}

/** At start: forgets what the lease no longer covers, then renews it every hour while open. */
export function keepToTheLease(every = 3_600_000): () => void {
  const forget = () => void sweep(offlineEnv(), typeof indexedDB === "undefined" ? undefined : indexedDB);
  forget();
  const timer = setInterval(() => void renewOfflineLease().then(forget), every);
  return () => clearInterval(timer);
}
