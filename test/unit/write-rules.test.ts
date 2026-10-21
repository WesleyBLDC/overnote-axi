/**
 * The pure rules of the write path: append and prepend no-op detection (src/markdown/compose.ts)
 * and the verify check after a write to the open note (MarkdownConverter.writeSurvived), the
 * latter against core's own mergeDocs, which is what an Overnote v2.14 editor runs.
 */
import { buildNoteContent, loadDoc, mergeDocs } from "@overnote/core";
import { describe, expect, it } from "vitest";

import { alreadyEdited, alreadyPresent } from "../../src/markdown/compose.js";
import { converter } from "../../src/markdown/convert.js";

describe("alreadyPresent", () => {
  it("matches whole trailing or leading blocks only", () => {
    expect(alreadyPresent("# List\n\n- milk", "- milk", "append")).toBe(true);
    expect(alreadyPresent("- milk\n- eggs\n", "- eggs", "append")).toBe(true);
    expect(alreadyPresent("call Sam", "Sam", "append")).toBe(false);
    expect(alreadyPresent("# List\n\nbody", "# List", "prepend")).toBe(true);
    expect(alreadyPresent("# Listing", "# List", "prepend")).toBe(false);
    expect(alreadyPresent("same", " same ", "prepend")).toBe(true);
  });

  it("never treats an empty addition as present", () => {
    expect(alreadyPresent("text", "  ", "append")).toBe(false);
    expect(alreadyPresent("", "", "append")).toBe(false);
  });
});

describe("alreadyEdited", () => {
  const retry = (markdown: string, newText: string, oldText = "gone", all = false) =>
    alreadyEdited(markdown, newText, { oldText, all, normalizedNew: newText });

  it("takes a retry of a whole line edit as applied", () => {
    expect(retry("- [x] ship\n- [ ] test", "- [x] ship", "- [ ] ship")).toBe(true);
    expect(retry("Standup\n\nAs of Oct 20  \n\nbody", "As of Oct 20", "As of Oct 19")).toBe(true);
    expect(retry("a\n\nb\n\nc", "a\n\nb")).toBe(true);
  });

  it("refuses partial lines, repeats, --all, blank text, and an --old that is still there", () => {
    expect(retry("[x]", "x")).toBe(false);
    expect(retry("- [ ] call Sam", "Sam")).toBe(false);
    expect(retry("done\n\ndone", "done")).toBe(false);
    expect(retry("done\n\nundone", "done")).toBe(false);
    expect(retry("- [x] ship", "- [x] ship", "gone", true)).toBe(false);
    expect(retry("text", "  ")).toBe(false);
    expect(retry("old\n\nnew", "new", "old")).toBe(false);
  });
});

describe("writeSurvived", () => {
  const before = converter.fromMarkdown("Draft\n\nSecond");
  const written = converter.compose(before, "From the CLI", "append");
  const typed = converter.fromMarkdown("Draft mine\n\nSecond");

  function editorMerge(local: typeof typed) {
    const merge = mergeDocs(
      loadDoc(before.rawContent, before.text),
      loadDoc(local.rawContent, local.text),
      loadDoc(written.rawContent, written.text),
    );
    return { merge, after: buildNoteContent(merge.doc) };
  }

  it("is true when nothing changed after the write", () => {
    expect(converter.writeSurvived(before, written, written)).toBe(true);
  });

  it("is true when a merging editor (Overnote v2.14) saved typing around the write", () => {
    const { merge, after } = editorMerge(typed);
    expect(merge.conflicted).toBe(false);
    expect(after.markdown).toBe("Draft mine\n\nSecond\n\nFrom the CLI");
    expect(converter.writeSurvived(before, written, after)).toBe(true);
  });

  it("is true when the merge kept both versions of a block both sides changed", () => {
    const edited = converter.edit(before, "Second", "Second (CLI)", false);
    if (edited.status !== "ok") throw new Error("setup");
    const local = converter.fromMarkdown("Draft\n\nSecond (mine)");
    const merge = mergeDocs(
      loadDoc(before.rawContent, before.text),
      loadDoc(local.rawContent, local.text),
      loadDoc(edited.content.rawContent, edited.content.text),
    );
    expect(merge.conflicted).toBe(true);
    expect(converter.writeSurvived(before, edited.content, buildNoteContent(merge.doc))).toBe(true);
  });

  it("is false when an older editor saved its own version over the write", () => {
    expect(converter.writeSurvived(before, written, typed)).toBe(false);
    expect(converter.writeSurvived(before, written, before)).toBe(false);
  });

  it("is false when a block the write removed came back", () => {
    const edited = converter.edit(before, "Second", "Changed", false);
    if (edited.status !== "ok") throw new Error("setup");
    const reverted = converter.fromMarkdown("Draft\n\nSecond\n\nChanged");
    expect(converter.writeSurvived(before, edited.content, reverted)).toBe(false);
  });

  it("is false when an older editor dropped an appended copy of a block that already existed", () => {
    const repeated = converter.fromMarkdown("# Todo\n\n---\n\nbody");
    const appended = converter.compose(repeated, "---", "append");
    expect(appended.markdown).toBe("# Todo\n\n---\n\nbody\n\n---");
    expect(converter.writeSurvived(repeated, appended, repeated)).toBe(false);
    expect(converter.writeSurvived(repeated, appended, appended)).toBe(true);
  });

  it("is true when typing elsewhere kept the appended copy of a repeated block", () => {
    const repeated = converter.fromMarkdown("Same\n\nother");
    const appended = converter.compose(repeated, "Same", "append");
    const typedAround = converter.fromMarkdown("Same\n\nother mine\n\nSame");
    expect(converter.writeSurvived(repeated, appended, typedAround)).toBe(true);
  });

  it("is false when a removed copy of one of two identical blocks came back", () => {
    const twice = converter.fromMarkdown("Same\n\nmiddle\n\nSame");
    const removed = converter.fromMarkdown("Same\n\nmiddle");
    expect(converter.writeSurvived(twice, removed, twice)).toBe(false);
    expect(converter.writeSurvived(twice, removed, converter.fromMarkdown("Same\n\nmiddle mine"))).toBe(true);
  });
});
