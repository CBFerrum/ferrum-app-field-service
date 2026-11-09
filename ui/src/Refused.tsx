// What the server refused of what was done on this phone, kept until the technician decides: try it
// again (once it is put right, or once what stood in its way has changed), save a copy, or discard it,
// which is confirmed and noted on the job. A job with one is not completed meanwhile.

import { isolate, saveBlob, t } from "@ferrum/client";
import { Alert, Button, confirmDialog, toast } from "@ferrum/kit";
import { blobStore, discard, exported, type Refusal, retry } from "./offline";
import { clock } from "./time";

export function Refused({ list, by, zone, onChange }: { list: Refusal[]; by: string; zone: string; onChange: () => void }) {
  if (!list.length) return null;
  const again = (r: Refusal) => {
    if (retry(r.step.key)) onChange();
    else toast(t("This phone cannot keep it."), "error");
  };
  const copy = async (r: Refusal) => {
    saveBlob(new Blob([exported(r)], { type: "application/json" }), `${r.step.key}.json`);
    if (r.step.action === "sign" || r.step.action === "photo") {
      const blob = await blobStore()?.get(r.step.blob);
      if (blob) saveBlob(blob, r.step.action === "sign" ? "signature.png" : r.step.file_name);
    }
  };
  const drop = async (r: Refusal) => {
    const ok = await confirmDialog({
      title: t("Discard this?"),
      message: t("{label} goes from this phone, with its picture if it has one, and a note saying so is added to the job.", { label: r.step.label }),
      confirmLabel: t("Discard"),
      danger: true,
    });
    if (!ok) return;
    if (await discard(r.step.key, by, undefined, blobStore())) onChange();
    else toast(t("This phone cannot keep it."), "error");
  };
  return (
    <Alert tone="error">
      <strong>{t("Refused, waiting for you")}</strong>
      <ul className="fs-refused">
        {list.map((r) => (
          <li key={r.step.key}>
            <span>
              {isolate(r.step.label)}, {isolate(clock(Date.parse(r.at), zone))}: {isolate(r.reason)}
            </span>
            <span className="fs-refused-actions">
              <Button size="sm" onClick={() => again(r)}>
                {t("Try again")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copy(r)}>
                {t("Save a copy")}
              </Button>
              <Button size="sm" variant="danger" onClick={() => void drop(r)}>
                {t("Discard")}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
