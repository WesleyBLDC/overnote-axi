import { describe, expect, it } from "vitest";

import {
  listColumns,
  needsPinPositions,
  oneLine,
  pinPositions,
  PREVIEW_LENGTH,
  previewOf,
  summaryTitle,
} from "../../src/commands/note-columns.js";
import { rows } from "../../src/output/render.js";
import { createFakes, summary } from "../fixtures/fakes.js";

describe("note columns", () => {
  it("titles a row like the app: stored title, else first text line, else Untitled", () => {
    expect(summaryTitle({ title: "Stored", preview: "First line" })).toBe("Stored");
    expect(summaryTitle({ title: "  ", preview: "\n  First line\nsecond" })).toBe("First line");
    expect(summaryTitle({ title: "", preview: "" })).toBe("Untitled");
  });

  it("puts text on one line and cuts previews in code points", () => {
    expect(oneLine("  a\n\n b\t c  ")).toBe("a b c");
    const preview = previewOf({ title: "Emoji", preview: `Emoji\n${"😀".repeat(PREVIEW_LENGTH)}tail` });
    expect(Array.from(preview)).toHaveLength(PREVIEW_LENGTH);
    expect(preview.endsWith("😀")).toBe(true);
  });

  it("starts the preview after the title line", () => {
    expect(previewOf({ title: "Standup", preview: "Standup\n- [ ] demo\n- [ ] ship" })).toBe("- [ ] demo - [ ] ship");
    expect(previewOf({ title: "", preview: "\n  Plan\nfirst" })).toBe("first");
    expect(previewOf({ title: "Only", preview: "Only" })).toBe("");
    // A stored title that is not the first line keeps the whole text.
    expect(previewOf({ title: "Other", preview: "Body\nmore" })).toBe("Body more");
  });

  it("numbers pins 1 to N in pin order whatever the stored keys are", () => {
    const { store, reader } = createFakes();
    const late = store.add({ body: "Late", pinned: 2000.5 });
    const early = store.add({ body: "Early", pinned: 1000 });
    store.add({ body: "Loose" });
    store.add({ body: "Gone", pinned: 500, deletedAt: store.clock });
    expect([...pinPositions(reader)]).toEqual([
      [early.id, 1],
      [late.id, 2],
    ]);
  });

  it("returns no positions without pins", () => {
    const { store, reader } = createFakes();
    store.add({ body: "Loose" });
    expect(pinPositions(reader).size).toBe(0);
  });

  it("renders every field, empty cells for missing values, each field once", () => {
    const { store } = createFakes();
    const note = store.add({ body: "Title\nbody text", pinned: 1000, lastAccessedAt: null });
    const columns = listColumns(["id", "pinned", "accessed", "deleted", "chars", "preview", "id"], new Map([[note.id, 3]]));
    expect(rows([summary(note)], columns)).toEqual([
      { id: note.id, pinned: 3, accessed: "", deleted: "", chars: 15, preview: "body text" },
    ]);
    const loose = store.add({ body: "Loose" });
    expect(rows([summary(loose)], listColumns(["pinned"], new Map()))).toEqual([{ pinned: "" }]);
  });

  it("asks for pin positions only when the pinned field is shown", () => {
    expect(needsPinPositions(["id", "pinned"])).toBe(true);
    expect(needsPinPositions(["id", "title"])).toBe(false);
  });
});
