// What a job leaves behind: the photos taken on site, the notes, and the customer's signature with
// the name of who signed. Photos are made smaller on the phone before they are sent, because the
// signal where a job is can be poor.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, docPath, fetchBlob, uploadFile } from "@ferrum/client";
import { Button, confirmDialog, Dialog, Field, Icon, Spinner, toast } from "@ferrum/kit";
import { reason } from "./api";
import { fitWithin, isImage } from "./job";
import { type Ctx } from "./Sections";
import { SignaturePad } from "./Sign";
import { clock, dayLabel, dayOf } from "./time";

interface Attachment {
  id: string;
  file_name: string;
  size_bytes: number;
  url: string;
}

/** A file of the platform as a picture the page can show (its address needs the session). */
function useBlobUrl(path: string | null | undefined) {
  const blob = useQuery({ queryKey: ["fs", "blob", path], enabled: !!path, staleTime: Infinity, gcTime: 5 * 60_000, queryFn: () => fetchBlob(path!) });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return setUrl(null);
    const u = URL.createObjectURL(blob.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob.data]);
  return { url, failed: blob.isError };
}

/** A photo drawn within `max` pixels on its longer side, as a smaller JPEG; the file itself if that is no smaller or this browser cannot. */
async function shrink(file: File, max = 1600): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
    if (width >= bitmap.width) {
      bitmap.close();
      return file;
    }
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    c.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", 0.82));
    return jpeg && jpeg.size < file.size ? new File([jpeg], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

function Thumb({ file, onOpen }: { file: Attachment; onOpen: (f: Attachment) => void }) {
  const { url, failed } = useBlobUrl(file.url);
  return (
    <button type="button" className="fs-thumb" onClick={() => onOpen(file)} aria-label={`Open ${file.file_name}`}>
      {url ? <img src={url} alt="" /> : failed ? <Icon name="alert" /> : <Spinner small />}
    </button>
  );
}

function Viewer({ file, editable, onClose, onRemoved }: { file: Attachment; editable: boolean; onClose: () => void; onRemoved: () => void }) {
  const { url } = useBlobUrl(file.url);
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete this photo?", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.del(`/api/files/${file.id}`);
      onRemoved();
      onClose();
    } catch (e) {
      toast(reason(e), "error");
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={file.file_name}
      wide
      footer={
        editable ? (
          <Button variant="danger" onClick={() => void remove()}>
            Delete the photo
          </Button>
        ) : undefined
      }
    >
      {url ? <img className="fs-photo" src={url} alt={file.file_name} /> : <Spinner label="Loading the photo" />}
    </Dialog>
  );
}

export function Photos({ ctx }: { ctx: Ctx }) {
  const qc = useQueryClient();
  const key = ["fs", "files", ctx.id];
  const files = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<{ attachments: Attachment[] }>(docPath("ServiceWorkOrder", ctx.id, "attachments"), undefined, signal).then((r) => r.attachments) });
  const [open, setOpen] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const signature = typeof ctx.doc.customer_signature === "string" ? ctx.doc.customer_signature : null;
  const photos = (files.data ?? []).filter((f) => isImage(f.file_name) && f.url !== signature);
  const add = async (picked: FileList | null) => {
    const list = Array.from(picked ?? []);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const f of list) await uploadFile(await shrink(f), { entity: "ServiceWorkOrder", id: ctx.id });
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast(reason(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="photos" className="fs-sec" aria-labelledby="fs-h-photos">
      <h2 id="fs-h-photos" className="fs-sec-h">
        Photos {photos.length > 0 && <span className="faint">{photos.length}</span>}
      </h2>
      {files.isPending ? (
        <Spinner label="Loading photos" />
      ) : files.isError ? (
        <p className="muted">The photos could not be loaded.</p>
      ) : photos.length ? (
        <div className="fs-thumbs">
          {photos.map((f) => (
            <Thumb key={f.id} file={f} onOpen={setOpen} />
          ))}
        </div>
      ) : (
        <p className="muted">No photos yet.</p>
      )}
      {ctx.editable && (
        <div className="fs-photo-add">
          <label className="btn btn-default btn-md" aria-busy={busy}>
            <Icon name="upload" size={15} /> {busy ? "Sending…" : "Take a photo"}
            <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={busy} onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="btn btn-default btn-md" aria-busy={busy}>
            Choose photos
            <input type="file" accept="image/*" multiple className="sr-only" disabled={busy} onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      )}
      {open && <Viewer file={open} editable={ctx.editable} onClose={() => setOpen(null)} onRemoved={() => void qc.invalidateQueries({ queryKey: key })} />}
    </section>
  );
}

export function Signoff({ ctx }: { ctx: Ctx }) {
  const signature = typeof ctx.doc.customer_signature === "string" ? ctx.doc.customer_signature : null;
  const signedBy = typeof ctx.doc.signed_by === "string" ? ctx.doc.signed_by : "";
  const signedAt = typeof ctx.doc.signed_at === "string" ? ctx.doc.signed_at : null;
  const notes = typeof ctx.doc.work_notes === "string" ? ctx.doc.work_notes : "";
  const [name, setName] = useState(signedBy);
  const [text, setText] = useState(notes);
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const image = useBlobUrl(signature);
  // A change from elsewhere (the job read again) replaces what was typed only once it differs from what was saved.
  useEffect(() => setText(notes), [notes]);
  useEffect(() => setName(signedBy), [signedBy]);

  const keepNotes = () => {
    if (text.trim() !== notes.trim()) void ctx.save({ work_notes: text.trim() || null });
  };
  const sign = async (png: Blob) => {
    setBusy(true);
    try {
      const stored = await uploadFile(new File([png], "signature.png", { type: "image/png" }), { entity: "ServiceWorkOrder", id: ctx.id });
      const out = await ctx.save({ customer_signature: stored.url, signed_by: name.trim() });
      if (out.ok) setAgain(false);
    } catch (e) {
      toast(reason(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const showPad = ctx.editable && (!signature || again);
  return (
    <section id="signoff" className="fs-sec" aria-labelledby="fs-h-signoff">
      <h2 id="fs-h-signoff" className="fs-sec-h">
        Sign-off
      </h2>
      <Field label="What was done" htmlFor="work-notes" hint={ctx.editable ? "Saved when you leave the box." : undefined}>
        <textarea id="work-notes" className="textarea" rows={3} readOnly={!ctx.editable} value={text} onChange={(e) => setText(e.target.value)} onBlur={keepNotes} />
      </Field>
      {signature && !again && (
        <div className="fs-signed">
          {image.url ? <img src={image.url} alt={`Signature of ${signedBy || "the customer"}`} /> : <Spinner small />}
          <p>
            Signed by <strong>{signedBy || "the customer"}</strong>
            {signedAt ? `, ${dayLabel(dayOf(Date.parse(signedAt), ctx.zone))} ${clock(Date.parse(signedAt), ctx.zone)}` : ""}
          </p>
          {ctx.editable && (
            <Button size="sm" onClick={() => setAgain(true)}>
              Sign again
            </Button>
          )}
        </div>
      )}
      {showPad && (
        <div className="fs-sign">
          <Field label="Name of the person signing" htmlFor="signed-by" required>
            <input id="signed-by" className="input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <SignaturePad busy={busy} blocked={name.trim() ? undefined : "Write who is signing first"} onSave={(png) => void sign(png)} />
        </div>
      )}
      {!signature && !ctx.editable && <p className="muted">The customer did not sign.</p>}
    </section>
  );
}
