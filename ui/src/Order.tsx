// A work order's page. The same job is two screens: the technician's, built for a phone and the
// next step, and the office's, with the whole state in one place. Whoever plans gets the office's
// (and the technician's by `?as=field` when they work jobs too); everyone else gets the technician's.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { api, type FieldError } from "@ferrum/client";
import { ErrorState, PageLoading, useShellTitle } from "@ferrum/kit";
import { can, useEntityMeta, useMe } from "@ferrum/records";
import { Cockpit } from "./Cockpit";
import { DEFAULT_RULES, type Rules } from "./job";
import { JobSheet, type View } from "./JobSheet";
import { plans, works } from "./roles";
import type { Ctx } from "./Sections";
import { Stale } from "./Stale";
import { useWork } from "./useWork";
import "./work.css";

export function OrderRoute() {
  const { id = "" } = useParams();
  return <Order key={id} id={id} />;
}

function Order({ id }: { id: string }) {
  const [sp] = useSearchParams();
  const me = useMe().data;
  const meta = useEntityMeta("ServiceWorkOrder");
  const work = useWork(id);
  const [refused, setRefused] = useState<FieldError[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // What the settings ask of a job before it is completed (the platform checks again).
  const rules = useQuery({
    queryKey: ["fs", "rules"],
    staleTime: 5 * 60_000,
    queryFn: () =>
      api
        .get<{ rows: Partial<Rules>[] }>("/api/v1/FieldServiceSettings", { fields: "require_checklist,require_signature", limit: 1 })
        .then((r) => ({ ...DEFAULT_RULES, ...(r.rows[0] ?? {}) }) as Rules)
        .catch(() => DEFAULT_RULES),
  });
  const doc = work.doc;
  useShellTitle(doc ? `${String(doc.number ?? "Work order")} ${String(doc.customer_name ?? "")}`.trim() : null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (work.query.error && !doc) return <ErrorState error={work.query.error} onRetry={() => void work.query.refetch()} />;
  if (meta.error) return <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />;
  if (!doc || !meta.data || !me) return <PageLoading />;

  const as = sp.get("as");
  const office = as === "field" ? false : as === "office" ? true : plans(me.user);
  const status = String(doc.status ?? "");
  const editable = can(meta.data.permissions, "write") && Number(doc.docstatus ?? 0) === 0 && status !== "Cancelled";
  const types = meta.data.children.expenses?.fields.find((f) => f.name === "expense_type")?.options ?? [];
  const ctx: Ctx = {
    id,
    doc,
    zone: me.timezone ?? "UTC",
    editable,
    office,
    // Any edit clears what a refused completion said: the person is putting it right.
    save: (fields, shown) => {
      setRefused([]);
      return work.save(fields, shown);
    },
    refused,
    expenseTypes: types,
  };
  const view: View = {
    ctx,
    rules: rules.data ?? DEFAULT_RULES,
    run: work.run,
    setRefused,
    now,
    switch: plans(me.user) && works(me.user),
    saving: work.saving,
  };
  return (
    <>
      {work.query.error && <Stale error={work.query.error} onRetry={() => void work.query.refetch()} />}
      {office ? <Cockpit v={view} meta={meta.data} /> : <JobSheet v={view} />}
    </>
  );
}
