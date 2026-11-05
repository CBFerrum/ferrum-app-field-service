// Sending what was done offline (offline.ts): each step as the server takes it, one send at a time
// whichever page starts it. Setting off, arriving and completing carry when they were taken; a
// change is made again on the job as it stands now and goes against that version; a picture is
// uploaded first, then named on the job.

import type { QueryClient } from "@tanstack/react-query";
import { api, docPath, uploadFile } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { act, reason } from "./api";
import { blobStore, patchFor, send, type Sent, type Waiting, waiting } from "./offline";

interface Job {
  id: string;
  version: number;
  [field: string]: unknown;
}

const job = (id: string) => api.get<Job>(docPath("ServiceWorkOrder", id));

/** Sends one step; throws as the server answers (unreachable: it waits; refused: it is dropped). */
export async function perform(w: Waiting): Promise<void> {
  const id = w.work_order;
  switch (w.action) {
    case "start_travel":
    case "arrive":
    case "complete":
      // When it was taken, not when it is sent: the arrival and completion times judge the SLA.
      await act("ServiceWorkOrder", id, w.action, { at: w.at });
      return;
    case "save": {
      const now = await job(id);
      const fields = patchFor(now, w.edits);
      if (fields) await api.patch(docPath("ServiceWorkOrder", id), fields, { ifMatch: now.version });
      return;
    }
    case "sign":
    case "photo": {
      const blob = await blobStore()?.get(w.blob);
      if (!blob) throw new Error(w.action === "sign" ? "the signature's picture is no longer on this phone" : "the photo is no longer on this phone");
      const name = w.action === "sign" ? "signature.png" : w.file_name;
      const stored = await uploadFile(new File([blob], name, { type: blob.type || "image/png" }), { entity: "ServiceWorkOrder", id });
      if (w.action === "sign") {
        const now = await job(id);
        await api.patch(docPath("ServiceWorkOrder", id), { customer_signature: stored.url, signed_by: w.signed_by }, { ifMatch: now.version });
      }
      return;
    }
  }
}

let running: Promise<Sent> | null = null;

/** Sends what waits, once at a time, and says what went and what was refused. */
export function flush(qc: QueryClient): Promise<Sent> {
  if (running) return running;
  if (!waiting().length) return Promise.resolve({ sent: [], refused: [], dropped: [] });
  running = send(perform, reason, undefined, blobStore())
    .then((out) => {
      if (out.sent.length) toast(`Sent what you did offline: ${out.sent.map((w) => w.label).join(", ")}.`);
      for (const r of out.refused) toast(`${r.step.label}: ${r.reason}`, "error");
      if (out.dropped.length) toast(`Not completed, as something before it was refused: ${out.dropped.map((w) => w.label).join(", ")}. Put it right, then complete the job again.`, "error");
      if (out.sent.length || out.refused.length || out.dropped.length) void qc.invalidateQueries({ queryKey: ["fs"] });
      return out;
    })
    .finally(() => {
      running = null;
    });
  return running;
}
