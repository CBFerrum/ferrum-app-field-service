// One work order, and the writes to it. Changes show at once and go to the server one after
// another, each against the version the last one left, so quick ticks on a phone never collide with
// each other; if one is refused, the ones built on it are dropped and the job is read again, and the
// reason is told. Without a connection the job is read as this phone last kept it, and what the
// technician does is kept to send when the connection is back (offline.ts), in the order done.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, docPath, type FieldError } from "@ferrum/client";
import { toast, useLiveEntity } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { act, reason } from "./api";
import { flush } from "./held";
import { applied, edits, forgetAdd, hold, keepJob, keptJob, type Step, unreachable, type Waiting, waiting } from "./offline";
import { Serial } from "./serial";

export interface Outcome {
  ok: boolean;
  /** What the server refused, row by row, when it did. */
  fields: FieldError[];
  message?: string;
  /** Kept on this phone, to send when the connection is back. */
  held?: boolean;
}

/** Steps the job page takes that wait for the connection when there is none. */
const HELD_ACTIONS = ["start_travel", "arrive", "complete"] as const;

export function useWork(id: string) {
  const qc = useQueryClient();
  const key = useMemo(() => ["fs", "wo", id], [id]);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        const doc = await api.get<Doc>(docPath("ServiceWorkOrder", id), { titles: true }, signal);
        keepJob(id, doc);
        return doc;
      } catch (e) {
        const kept = unreachable(e) ? keptJob<Doc>(id) : null;
        if (!kept) throw e;
        return { ...kept.data, _offline: kept.at } as Doc;
      }
    },
  });
  const version = useRef(0);
  const queue = useRef(new Serial());
  const stale = useRef(false);
  /** The job as the server last said it: what the page goes back to when a change is refused. */
  const truth = useRef<Doc | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const mine = useCallback(() => waiting().filter((w) => w.work_order === id), [id]);
  const [held, setHeld] = useState(mine);
  const reheld = useCallback(() => setHeld(mine()), [mine]);
  /** The job as the technician left it: what the server said, with what waits on this phone. */
  const doc = useMemo(() => (query.data ? applied(query.data, held) : undefined), [query.data, held]);

  useEffect(() => {
    if (query.data && queue.current.idle) {
      truth.current = query.data;
      if (query.data.version != null) version.current = Number(query.data.version);
    }
  }, [query.data]);

  // What waits goes when the server answers again: at once, and whenever the phone is back online.
  useEffect(() => {
    const send = () => void flush(qc).then(reheld);
    if (navigator.onLine) send();
    window.addEventListener("online", send);
    return () => window.removeEventListener("online", send);
  }, [qc, reheld]);

  // Someone else's change arrives as an event; one of our own writes in flight reads the job again when it is done.
  useLiveEntity(
    "ServiceWorkOrder",
    useCallback(
      (e) => {
        if (e.id !== id) return;
        if (!queue.current.idle) stale.current = true;
        else void qc.invalidateQueries({ queryKey: key });
      },
      [id, key, qc],
    ),
  );

  const label = useCallback((what: string) => `${what}: ${String(query.data?.customer_name ?? query.data?.number ?? "a job")}`, [query.data]);

  /** Keeps a change on this phone; false when it cannot (no lease to keep it under, or no room). */
  const keepChange = useCallback(
    (before: Doc, fields: Record<string, unknown>, shown: Record<string, unknown>): boolean => {
      // A row added here and taken out again before it was sent goes from what waits, and is not sent at all.
      const list = edits(before, fields, shown).filter((e) => !(e.kind === "remove" && e.row.startsWith("new-") && forgetAdd(e.row)));
      const ok = list.length === 0 || hold({ work_order: id, action: "save", edits: list, at: new Date().toISOString(), label: label("Changes") });
      reheld();
      return ok;
    },
    [id, label, reheld],
  );

  /** Saves fields (a table's rows replace its rows) and shows `shown` meanwhile. */
  const save = useCallback(
    (fields: Record<string, unknown>, shown: Record<string, unknown> = fields): Promise<Outcome> => {
      const before = applied(qc.getQueryData<Doc>(key) ?? ({} as Doc), mine());
      // While steps wait, a new one waits behind them, so they all go in the order they were done.
      if (waiting().length) {
        if (!keepChange(before, fields, shown)) return Promise.resolve({ ok: false, fields: [], message: "This phone cannot keep the change." });
        void flush(qc).then(reheld);
        return Promise.resolve({ ok: true, fields: [], held: true });
      }
      qc.setQueryData<Doc>(key, (d) => d && { ...d, ...shown });
      setSaving(true);
      const write = async (): Promise<Outcome> => {
        try {
          const next = await api.patch<Doc>(docPath("ServiceWorkOrder", id), fields, { ifMatch: version.current });
          version.current = Number(next.version);
          truth.current = { ...next, _titles: { ...truth.current?._titles, ...next._titles } };
          keepJob(id, truth.current);
          // While more changes wait, the page keeps showing them; the last one shows the server's word.
          if (queue.current.pending === 1) qc.setQueryData<Doc>(key, truth.current);
          return { ok: true, fields: [] };
        } catch (e) {
          // No connection: the change waits on this phone and still shows (it is kept, not lost).
          if (unreachable(e) && keepChange(before, fields, shown)) {
            if (truth.current) qc.setQueryData<Doc>(key, truth.current);
            toast("No connection: kept on this phone, and sent when the connection is back.");
            return { ok: true, fields: [], held: true };
          }
          stale.current = true;
          // The change was never made: show the job as it is.
          if (truth.current) qc.setQueryData<Doc>(key, truth.current);
          const conflict = e instanceof ApiError && (e.status === 409 || e.status === 412);
          const message = conflict ? "Someone else changed this job. Here it is as it stands now." : reason(e);
          toast(message, "error");
          return { ok: false, fields: e instanceof ApiError ? e.fields : [], message };
        }
      };
      return queue.current
        .add(write, (o) => o.ok)
        .then((o) => o ?? { ok: false, fields: [] })
        .finally(() => {
          if (!queue.current.idle) return;
          setSaving(false);
          if (stale.current) {
            stale.current = false;
            void qc.invalidateQueries({ queryKey: key });
          }
        });
    },
    [id, key, qc, keepChange, mine, reheld],
  );

  /** Runs an action of the work order once the saves before it have landed; the board and the day
   *  are read again. Setting off, arriving and completing wait on this phone without a connection. */
  const run = useCallback(
    async (action: string, body: unknown = {}): Promise<Outcome & { result?: unknown }> => {
      await queue.current.add(async () => true);
      const holdable = (HELD_ACTIONS as readonly string[]).includes(action);
      const keep = () => {
        const what = action === "complete" ? "Completed" : action === "arrive" ? "On site" : "On your way";
        const ok = hold({ work_order: id, action: action as (typeof HELD_ACTIONS)[number], at: new Date().toISOString(), label: label(what) });
        reheld();
        return ok;
      };
      if (holdable && waiting().length) {
        if (!keep()) return { ok: false, fields: [], message: "This phone cannot keep it." };
        void flush(qc).then(reheld);
        return { ok: true, fields: [], held: true };
      }
      try {
        const result = await act("ServiceWorkOrder", id, action, body);
        return { ok: true, fields: [], result };
      } catch (e) {
        if (holdable && unreachable(e) && keep()) return { ok: true, fields: [], held: true };
        return { ok: false, fields: e instanceof ApiError ? e.fields : [], message: reason(e) };
      } finally {
        // This job first: some actions move its version, and the next change is made against it.
        await qc.invalidateQueries({ queryKey: key });
        const fresh = qc.getQueryData<Doc>(key);
        if (fresh?.version != null) {
          version.current = Number(fresh.version);
          truth.current = fresh;
        }
        void qc.invalidateQueries({ queryKey: ["fs"] });
      }
    },
    [id, key, qc, label, reheld],
  );

  return {
    query,
    doc,
    save,
    run,
    saving,
    /** Steps of this job waiting on this phone. */
    held: held.length,
    completedHere: held.some((w) => w.action === "complete"),
    /** Keeps a step of this job (a signature, a photo) to send when the connection is back. */
    hold: (step: Step) => {
      const ok = hold(step);
      reheld();
      return ok;
    },
    heldPhotos: held.filter((w): w is Extract<Waiting, { action: "photo" }> => w.action === "photo"),
    /** When the job shown was kept, when the server could not be reached. */
    offline: typeof query.data?._offline === "string" ? query.data._offline : null,
    refresh: () => qc.invalidateQueries({ queryKey: key }),
  };
}
