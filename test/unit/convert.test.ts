import { describe, expect, it } from "vitest";

import * as core from "@overnote/core";
import type { JSONContent } from "@overnote/core";

import type { NoteContent, StoredNote } from "../../src/domain/types.js";
import { converter, suffixedContent } from "../../src/markdown/convert.js";

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

  it("prepends below the title line, or on top with top", () => {
    const titled = stored([paragraph("Plan"), paragraph("Body")]);
    expect(converter.compose(titled, "**Today**", "prepend").markdown).toBe("Plan\n\n**Today**\n\nBody");
    expect(converter.compose(titled, "**Today**", "top").markdown).toBe("**Today**\n\nPlan\n\nBody");
    expect(converter.belowTitle(titled)).toBe("Body");
    const heading = converter.fromMarkdown("# Standup\n\n- [ ] demo");
    expect(converter.compose(heading, "Notes", "prepend").markdown).toBe("# Standup\n\nNotes\n\n- [ ] demo");
    // A note that opens with a list has no title block: prepend goes on top.
    const list = converter.fromMarkdown("- [ ] a\n- [ ] b");
    expect(converter.belowTitle(list)).toBeNull();
    expect(converter.compose(list, "Today", "prepend").markdown).toBe("Today\n\n- [ ] a\n- [ ] b");
    // A title only note gets the addition right below it.
    expect(converter.compose(stored([paragraph("Body")]), "**Today**", "prepend").markdown).toBe("Body\n\n**Today**");
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

describe("a duplicate's title suffix", () => {
  /** Core's own rule when the bundled core has it (Overnote protocol v3.0). */
  const coreRule = (core as Readonly<Record<string, unknown>>)["duplicateContent"] as
    | ((note: StoredNote, suffix: string) => NoteContent)
    | undefined;

  /** The fallback's content, checked against the converter, core when present, and a save. */
  function copy(note: StoredNote, suffix = " copy"): NoteContent {
    const content = suffixedContent(note, suffix);
    expect(converter.duplicateContent(note, suffix)).toEqual(content);
    if (coreRule) expect(coreRule(note, suffix)).toEqual(content);
    // Every field comes from the suffixed document, so a later save derives the same title.
    expect(converter.current(content)).toEqual(content);
    return content;
  }
  const fromMarkdown = (markdown: string) => copy(converter.fromMarkdown(markdown));

  it("ends a heading's line with the suffix", () => {
    expect(fromMarkdown("# Groceries\n\n- milk")).toMatchObject({
      title: "Groceries copy",
      markdown: "# Groceries copy\n\n- milk",
      text: "Groceries copy\n\nmilk",
    });
  });

  it("puts it unmarked after a bold first line, before the hard break", () => {
    expect(fromMarkdown("**Plan**  \nsecond line")).toMatchObject({
      title: "Plan copy",
      markdown: "**Plan** copy  \nsecond line",
    });
    expect(fromMarkdown("**Plan**   trailing  \nnext").markdown).toBe("**Plan**   trailing copy  \nnext");
  });

  it("puts it on the first line of a code block that comes first", () => {
    expect(fromMarkdown("```\nfirst\nsecond\n```")).toMatchObject({ title: "first copy", text: "first copy\nsecond" });
  });

  it("starts an empty note with it (no leading space), and skips empty blocks before the title", () => {
    expect(fromMarkdown("")).toMatchObject({ title: "copy", text: "copy", markdown: "copy" });
    expect(copy(converter.fromMarkdown(""), "  ")).toEqual(converter.fromMarkdown(""));
    expect(fromMarkdown("**Plan**").markdown).toBe("**Plan** copy");
    expect(copy(stored([{ type: "paragraph" }, paragraph("Later")]))).toMatchObject({ title: "Later copy" });
    const breakFirst = stored([{ type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "second" }] }]);
    expect(copy(breakFirst).text).toBe("copy\nsecond");
    expect(fromMarkdown("- [ ] task one\n- [ ] two").markdown).toBe("- [ ] task one copy\n- [ ] two");
  });

  it("keeps the rest of the document exactly, unknown nodes included", () => {
    const note = stored([paragraph("Title"), unknownNode, collapsedToggle]);
    const content = copy(note);
    expect(blocksOf(content.rawContent)).toEqual([paragraph("Title copy"), ...blocksOf(converter.current(note).rawContent).slice(1)]);
    expect(copy(note, "")).toEqual(converter.current(note));
  });
});
