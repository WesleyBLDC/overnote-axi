import { describe, expect, it } from "vitest";

import { createFakes } from "../fixtures/fakes.js";

describe("shared fakes", () => {
  it("share one store between reader and writer and follow the protocol", async () => {
    const { store, reader, writer } = createFakes();
    const a = store.add({ body: "Alpha\nfirst" });
    const b = store.add({ body: "Beta" });
    await writer.pin(b.id);
    expect(reader.list({ limit: 10 }).items.map((note) => note.id)).toEqual([b.id, a.id]);

    const stale = await writer.update({ id: a.id, markdown: "x", expectedUpdatedAt: a.updatedAt - 1 });
    expect(stale.status).toBe("conflict");

    await writer.trash(b.id);
    expect(reader.counts()).toEqual({ live: 1, pinned: 0, trashed: 1 });
    await expect(writer.pin(b.id)).rejects.toMatchObject({ code: "NOTE_TRASHED" });
    await writer.permanentlyDelete(a.id);
    expect(reader.get(a.id)).not.toBeNull();
    await expect(writer.permanentlyDelete("01JAB00000ZZZZZZZZZZZZZZZZ")).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  });
});
