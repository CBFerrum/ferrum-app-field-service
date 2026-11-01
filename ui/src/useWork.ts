// One work order, and the writes to it. Changes show at once and go to the server one after
// another, each against the version the last one left, so quick ticks on a phone never collide with
// each other; if one is refused, the ones built on it are dropped and the job is read again, and the
// reason is told.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, docPath, type FieldError } from "@ferrum/client";
import { toast, useLiveEntity } from "@ferrum/kit";
import type { Doc } from "@ferrum/records";
import { act, reason } from "./api";
import { Serial } from "./serial";

export interface Outcome {
  ok: boolean;
  /** What the server refused, row by row, when it did. */
  fields: FieldError[];
  message?: string;
}

export function useWork(id: string) {
  const qc = useQueryClient();
  const key = useMemo(() => ["fs", "wo", id], [id]);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<Doc>(docPath("ServiceWorkOrder", id), { titles: true }, signal) });
  const version = useRef(0);
  const queue = useRef(new Serial());
  const stale = useRef(false);
  /** The job as the server last said it: what the page goes back to when a change is refused. */
  const truth = useRef<Doc | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (query.data && queue.current.idle) {
      truth.current = query.data;
      if (query.data.version != null) version.current = Number(query.data.version);
    }
  }, [query.data]);

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

  /** Saves fields (a table's rows replace its rows) and shows `shown` meanwhile. */
  const save = useCallback(
    (fields: Record<string, unknown>, shown: Record<string, unknown> = fields): Promise<Outcome> => {
      qc.setQueryData<Doc>(key, (d) => d && { ...d, ...shown });
      setSaving(true);
      const write = async (): Promise<Outcome> => {
        try {
          const next = await api.patch<Doc>(docPath("ServiceWorkOrder", id), fields, { ifMatch: version.current });
          version.current = Number(next.version);
          truth.current = { ...next, _titles: { ...truth.current?._titles, ...next._titles } };
          // While more changes wait, the page keeps showing them; the last one shows the server's word.
          if (queue.current.pending === 1) qc.setQueryData<Doc>(key, truth.current);
          return { ok: true, fields: [] };
        } catch (e) {
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
    [id, key, qc],
  );

  /** Runs an action of the work order once the saves before it have landed; the board and the day are read again. */
  const run = useCallback(
    async (action: string, body: unknown = {}): Promise<Outcome & { result?: unknown }> => {
      await queue.current.add(async () => true);
      try {
        const result = await act("ServiceWorkOrder", id, action, body);
        return { ok: true, fields: [], result };
      } catch (e) {
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
    [id, key, qc],
  );

  return { query, doc: query.data, save, run, saving, refresh: () => qc.invalidateQueries({ queryKey: key }) };
}
