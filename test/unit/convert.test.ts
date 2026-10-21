import { describe, expect, it } from "vitest";

import type { JSONContent } from "@overnote/core";

import { converter } from "../../src/markdown/convert.js";

const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

/** A stored note the way the helper hands it back: rawContent is canonical. */
function stored(content: JSONContent[]) {
  const rawContent = JSON.stringify({ type: "doc", content });
  return { rawContent, text: "" };
}

const unknownNode: JSONContent = { type: "futureWidget", attrs: { payload: 42 } };
const collapsedToggle: JSONContent = {
  type: "list",
  attrs: { kind: "toggle", order: null, checked: false, collapsed: true },
  content: [paragraph("Details"), paragraph("hidden body")],
};

function blocksOf(raw: string): JSONContent[] {
  return (JSON.parse(raw) as JSONContent).content ?? [];
}

describe("markdown conversion through @overnote/core", () => {
  it("derives every stored field the way the editor does", () => {
    const content = converter.fromMarkdown("# Groceries\n\n- [ ] milk\n- [x] eggs");
    expect(content.title).toBe("Groceries");
    expect(content.markdown).toBe("# Groceries\n\n- [ ] milk\n- [x] eggs");
    expect(JSON.parse(content.rawContent)).toMatchObject({ type: "doc" });
    expect(content.text).toContain("milk");
  });

  it("normalizes additions to the markdown core stores", () => {
    expect(converter.normalize("* item")).toBe("- item");
  });

  it("appends at the document level and keeps unknown nodes and collapsed toggles", () => {
    const note = stored([paragraph("Top"), unknownNode, collapsedToggle]);
    const result = converter.compose(note, "- [ ] new task", "append");
    const blocks = blocksOf(result.rawContent);
    expect(blocks[1]).toEqual(unknownNode);
    expect(blocks[2]?.attrs?.collapsed).toBe(true);
    expect(blocks.at(-1)?.attrs?.kind).toBe("task");
    expect(result.markdown).toContain("- [ ] new task");
  });

  it("prepends before the first block", () => {
    const result = converter.compose(stored([paragraph("Body")]), "**Today**", "prepend");
    expect(result.markdown).toBe("**Today**\n\nBody");
  });

  it("names what a markdown rewrite would lose", () => {
    expect(converter.rewriteLosses(stored([paragraph("plain")]))).toEqual([]);
    expect(converter.rewriteLosses(stored([paragraph("a"), unknownNode]))).toEqual(["unsupported-content"]);
    expect(converter.rewriteLosses(stored([collapsedToggle]))).toEqual(["collapsed-toggle"]);
  });

  it("edits only the blocks that contain the match", () => {
    const note = stored([paragraph("ship it"), unknownNode, collapsedToggle]);
    const outcome = converter.edit(note, "ship it", "shipped", false);
    expect(outcome).toMatchObject({ status: "ok", scope: "blocks", replaced: 1, losses: [] });
    if (outcome.status !== "ok") return;
    const blocks = blocksOf(outcome.content.rawContent);
    expect(blocks[0]).toEqual(paragraph("shipped"));
    expect(blocks[1]).toEqual(unknownNode);
    expect(blocks[2]?.attrs?.collapsed).toBe(true);
  });

  it("reports losses when the edited block itself cannot round trip", () => {
    const outcome = converter.edit(stored([collapsedToggle]), "hidden body", "shown", false);
    expect(outcome).toMatchObject({ status: "ok", losses: ["collapsed-toggle"] });
  });

  it("reports missing and ambiguous text", () => {
    const note = stored([paragraph("a b"), paragraph("a c")]);
    expect(converter.edit(note, "zzz", "y", false)).toEqual({ status: "not-found" });
    expect(converter.edit(note, "a", "y", false)).toEqual({ status: "ambiguous", matches: 2 });
    expect(converter.edit(note, "a", "y", true)).toMatchObject({ status: "ok", replaced: 2 });
  });

  it("falls back to the whole document for a match that spans blocks", () => {
    const outcome = converter.edit(stored([paragraph("one"), paragraph("two")]), "one\n\ntwo", "both", false);
    expect(outcome).toMatchObject({ status: "ok", scope: "document", replaced: 1 });
  });
});
