import { beforeEach, describe, expect, it, vi } from "vitest";
import { docPath } from "@ferrum/client";
import { canonical, editsDigest, perform, sha256 } from "./held";
import { type Edit, memoryBlobs } from "./offline";

// What reaches the server, in order, and what it holds: the job (the office added a part since), its
// files and its notes.
const { calls, server, pictures } = vi.hoisted(() => ({
  calls: [] as unknown[][],
  server: { job: {} as Record<string, unknown>, files: [] as { url: string; sha256: string | null }[], comments: [] as { body: string }[] },
  pictures: { blobs: null as ReturnType<typeof import("./offline").memoryBlobs> | null },
}));

vi.mock("./offline", async (original) => {
  const real = await original<typeof import("./offline")>();
  return { ...real, blobStore: () => pictures.blobs };
});
vi.mock("@ferrum/client", async (original) => {
  const real = await original<typeof import("@ferrum/client")>();
  const get = async (path: string) => (path.endsWith("/attachments") ? { attachments: server.files } : path.endsWith("/comments") ? { comments: server.comments } : server.job);
  return {
    ...real,
    api: {
      ...real.api,
      get,
      post: async (...a: unknown[]) => void calls.push(["post", ...a]),
      patch: async (...a: unknown[]) => void calls.push(["patch", ...a]),
    },
    uploadFile: async (file: File) => {
      calls.push(["upload", file.name]);
      return { id: "f2", url: "/files/f2", file_name: file.name, size: file.size };
    },
  };
});

beforeEach(() => {
  calls.length = 0;
  server.job = { id: "w1", version: 7, checklist: [{ id: "c1", done: false }], parts: [{ id: "p9", item: "Filter" }] };
  server.files = [];
  server.comments = [];
  pictures.blobs = memoryBlobs();
});

const at = "2026-11-06T09:00:00.000Z";
const tickAndAdd: Edit[] = [
  { kind: "tick", row: "c1", done: true },
  { kind: "add", table: "parts", row: { item: "Seal", qty: "2", client_ref: "new-1" }, ref: "new-1" },
];
const save = { key: "w1.save.1", work_order: "w1", action: "save" as const, at, label: "Changes", edits: tickAndAdd };

describe("sending a step held on the phone", () => {
  it("says when setting off, arriving and completing were taken, under the step's key", async () => {
    for (const action of ["start_travel", "arrive", "complete"] as const) await perform({ key: `k.${action}`, work_order: "w1", action, at, label: action });
    expect(calls).toEqual(
      ["start_travel", "arrive", "complete"].map((a) => ["post", docPath("ServiceWorkOrder", "w1", "actions", a), { at }, { idempotencyKey: `k.${a}`, idempotencyDigest: `${a}@${at}` }]),
    );
  });

  it("makes a change again on the job as it stands, against its version, with its key and a digest of what it does (FEO-003)", async () => {
    await perform(save);
    expect(calls).toEqual([
      [
        "patch",
        docPath("ServiceWorkOrder", "w1"),
        { checklist: [{ id: "c1", done: true }], parts: [{ id: "p9" }, { item: "Seal", qty: "2", client_ref: "new-1" }] },
        { ifMatch: 7, idempotencyKey: "w1.save.1", idempotencyDigest: await editsDigest(tickAndAdd) },
      ],
    ]);
  });

  it("binds the key to what the change does, not to the body it makes on the job", async () => {
    const reordered: Edit[] = [{ kind: "tick", done: true, row: "c1" }, { ref: "new-1", kind: "add", table: "parts", row: { qty: "2", client_ref: "new-1", item: "Seal" } }];
    expect(await editsDigest(reordered)).toBe(await editsDigest(tickAndAdd));
    expect(await editsDigest([tickAndAdd[0]])).not.toBe(await editsDigest(tickAndAdd));
    expect(canonical({ b: 1, a: [true, null, undefined], c: undefined })).toBe('{"a":[true,null,null],"b":1}');
  });

  it("sent again after the server did it, adds nothing twice", async () => {
    // The first try reached the server and its answer was lost: the row is there under its ref.
    server.job = { ...server.job, version: 8, checklist: [{ id: "c1", done: true }], parts: [{ id: "p9" }, { id: "p10", item: "Seal", client_ref: "new-1" }] };
    await perform(save);
    // The tick goes again (it changes nothing) under the same key, so the server answers as before.
    expect(calls).toEqual([["patch", docPath("ServiceWorkOrder", "w1"), { checklist: [{ id: "c1", done: true }] }, { ifMatch: 8, idempotencyKey: "w1.save.1", idempotencyDigest: await editsDigest(tickAndAdd) }]]);
    calls.length = 0;
    await perform({ ...save, edits: [tickAndAdd[1]] });
    expect(calls).toEqual([]);
  });

  it("does not upload a picture the job has already (by its content), and names it on the job once", async () => {
    const png = new Blob(["signature png"], { type: "image/png" });
    await pictures.blobs!.put("sig", png);
    server.files = [{ url: "/files/f1", sha256: await sha256(await png.arrayBuffer()) }];
    await perform({ key: "w1.sign.1", work_order: "w1", action: "sign", at, label: "Signed", blob: "sig", signed_by: "Pat Morgan" });
    expect(calls).toEqual([["patch", docPath("ServiceWorkOrder", "w1"), { customer_signature: "/files/f1", signed_by: "Pat Morgan" }, { ifMatch: 7, idempotencyKey: "w1.sign.1" }]]);
    calls.length = 0;
    await pictures.blobs!.put("photo", new Blob(["another picture"], { type: "image/jpeg" }));
    await perform({ key: "w1.photo.1", work_order: "w1", action: "photo", at, label: "A photo", blob: "photo", file_name: "boiler.jpg" });
    expect(calls).toEqual([["upload", "boiler.jpg"]]);
  });

  it("refuses a picture no longer on the phone, so the technician decides", async () => {
    await expect(perform({ key: "p", work_order: "w1", action: "photo", at, label: "A photo", blob: "gone", file_name: "a.jpg" })).rejects.toThrow("the photo is no longer on this phone");
    expect(calls).toEqual([]);
  });

  it("notes on the job once what was discarded", async () => {
    const note = { key: "w1.note.1", work_order: "w1", action: "note" as const, at, label: "Note", text: "Discarded on pat@acme.test's phone: Changes" };
    await perform(note);
    expect(calls).toEqual([["post", docPath("ServiceWorkOrder", "w1", "comments"), { body: note.text }]]);
    calls.length = 0;
    server.comments = [{ body: note.text }];
    await perform(note);
    expect(calls).toEqual([]);
  });
});
