// Sending what was done offline (offline.ts): each step as the server takes it, one send at a time
// whichever page or tab starts it. Each goes with its key, so the server does it once however often
// it comes. Setting off, arriving and completing carry when they were taken; a change is made again
// on the job as it stands now and goes against that version, with a digest of what it does (its
// body changes as the job does); a picture goes up unless the job already has it (by its content's
// digest), then is named on the job.

import type { QueryClient } from "@tanstack/react-query";
import { api, docPath, uploadFile, t } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { reason } from "./api";
import { actionDigest, blobStore, patchFor, send, type Edit, type Sent, type Waiting, waiting } from "./offline";

interface Job {
  id: string;
  version: number;
  [field: string]: unknown;
}

const job = (id: string) => api.get<Job>(docPath("ServiceWorkOrder", id));

/** JSON with its keys in order, so the same edits read the same wherever they were made. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** SHA-256 of `data`, in hex, as the server writes a file's. */
export async function sha256(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a change does, as the server binds its key to: the same for the same edits, whatever the job holds when it is sent. */
export const editsDigest = (edits: Edit[]) => sha256(canonical(edits));

interface Attachment {
  url: string;
  sha256?: string | null;
}

/** A picture on the job: the one it has with the same content, or uploaded now. */
async function placed(id: string, blob: Blob, name: string): Promise<string> {
  const digest = await sha256(await blob.arrayBuffer());
  const there = await api.get<{ attachments: Attachment[] }>(docPath("ServiceWorkOrder", id, "attachments"));
  const same = there.attachments.find((a) => a.sha256 === digest);
  return same ? same.url : (await uploadFile(new File([blob], name, { type: blob.type || "image/png" }), { entity: "ServiceWorkOrder", id })).url;
}

/** Sends one step; throws as the server answers (unreachable: it waits; refused: it is kept for the
 *  technician, and its job is not completed until they put it right or discard it). */
export async function perform(w: Waiting): Promise<void> {
  const id = w.work_order;
  switch (w.action) {
    case "start_travel":
    case "arrive":
    case "complete":
      // When it was taken, not when it is sent: the arrival and completion times judge the SLA.
      await api.post(docPath("ServiceWorkOrder", id, "actions", w.action), { at: w.at }, { idempotencyKey: w.key, idempotencyDigest: actionDigest(w.action, w.at) });
      return;
    case "save": {
      const now = await job(id);
      // Nothing left when the server did it already (its rows are there under their refs).
      const fields = patchFor(now, w.edits);
      if (fields) await api.patch(docPath("ServiceWorkOrder", id), fields, { ifMatch: now.version, idempotencyKey: w.key, idempotencyDigest: await editsDigest(w.edits) });
      return;
    }
    case "sign":
    case "photo": {
      const blob = await blobStore()?.get(w.blob);
      if (!blob) throw new Error(w.action === "sign" ? t("the signature's picture is no longer on this phone") : t("the photo is no longer on this phone"));
      const url = await placed(id, blob, w.action === "sign" ? "signature.png" : w.file_name);
      if (w.action === "sign") {
        const now = await job(id);
        await api.patch(docPath("ServiceWorkOrder", id), { customer_signature: url, signed_by: w.signed_by }, { ifMatch: now.version, idempotencyKey: w.key });
      }
      return;
    }
    case "note": {
      // Once: a note already on the job is not added again.
      const there = await api.get<{ comments: { body?: string }[] }>(docPath("ServiceWorkOrder", id, "comments"));
      if (!there.comments.some((c) => c.body === w.text)) await api.post(docPath("ServiceWorkOrder", id, "comments"), { body: w.text });
      return;
    }
  }
}

let running: Promise<Sent> | null = null;

/** Sends what waits, once at a time across this phone's tabs, and says what went and what was refused. */
export function flush(qc: QueryClient): Promise<Sent> {
  if (running) return running;
  if (!waiting().length) return Promise.resolve({ sent: [], refused: [], blocked: [] });
  const go = () => send(perform, reason, undefined, blobStore());
  // Another tab sending waits for this one, then finds what is left.
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const sending = async (): Promise<Sent> => (locks ? await locks.request("ferrum-field-service-send", go) : go());
  running = sending()
    .then((out) => {
      if (out.sent.length) toast(t("Sent what you did offline: {value}.", { value: out.sent.map((w) => w.label).join(", ") }));
      for (const r of out.refused) toast(`${r.step.label}: ${r.reason}`, "error");
      if (out.blocked.length) toast(t("Not completed yet: {value}. Something of the job was refused: try it again or discard it under My day.", { value: out.blocked.map((w) => w.label).join(", ") }), "error");
      if (out.sent.length || out.refused.length) void qc.invalidateQueries({ queryKey: ["fs"] });
      return out;
    })
    .finally(() => {
      running = null;
    });
  return running;
}
