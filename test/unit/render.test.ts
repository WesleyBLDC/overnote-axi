import { describe, expect, it } from "vitest";

import {
  collapseHome,
  column,
  renderEmpty,
  renderError,
  renderHelp,
  renderList,
  renderTextBlock,
  truncate,
} from "../../src/output/render.js";

describe("render", () => {
  it("renders a list with its aggregate count", () => {
    const items = [{ id: "01A", title: "One" }];
    const columns = [column<(typeof items)[number]>("id", (item) => item.id), column("title", (item: (typeof items)[number]) => item.title)];
    expect(renderList("notes", items, columns, { total: 40, noun: "live notes" })).toBe(
      "count: 1 of 40 live notes\nnotes[1]{id,title}:\n  01A,One",
    );
    expect(renderList("notes", items, columns, { total: 1, noun: "live notes" })).toBe(
      "count: 1 of 1 live note\nnotes[1]{id,title}:\n  01A,One",
    );
  });

  it("states empty results definitively", () => {
    expect(renderEmpty("notes", "0 live notes")).toBe("notes: 0 live notes");
  });

  it("renders help hints and errors", () => {
    expect(renderHelp(["overnote-axi list", ""])).toBe("help[1]:\n  overnote-axi list");
    expect(renderError("Note not found", "NOTE_NOT_FOUND", ["overnote-axi search x"])).toBe(
      "error: Note not found\ncode: NOTE_NOT_FOUND\nhelp[1]:\n  overnote-axi search x",
    );
  });

  it("indents text blocks and keeps blank lines empty", () => {
    expect(renderTextBlock("markdown", "# Title\n\nBody\n")).toBe("markdown:\n  # Title\n\n  Body");
    expect(renderTextBlock("markdown", "")).toBe("markdown: (empty)");
  });

  it("truncates with the total size", () => {
    const result = truncate("x".repeat(20), false, 10);
    expect(result).toEqual({
      text: "xxxxxxxxxx\n... (truncated, showing 10 of 20 markdown chars)",
      truncated: true,
      total: 20,
    });
    expect(truncate("short", false, 10).truncated).toBe(false);
  });

  it("counts and cuts in code points, never splitting an emoji", () => {
    const result = truncate("😀".repeat(4), false, 3);
    expect(result.total).toBe(4);
    expect(result.text.startsWith("😀😀😀\n")).toBe(true);
    expect(result.text).toContain("showing 3 of 4 markdown chars");
  });

  it("cuts at the last line break, else the last space, never mid word", () => {
    const lines = `${"a".repeat(90)}\n${"b".repeat(30)}`;
    expect(truncate(lines, false, 100).text).toBe(`${"a".repeat(90)}\n... (truncated, showing 90 of 121 markdown chars)`);
    const words = `${"word ".repeat(30)}`;
    const cut = truncate(words, false, 52);
    expect(cut.text.split("\n")[0]).toBe("word ".repeat(10).trim());
    expect(cut.text).toContain("showing 49 of 150 markdown chars");
    // A break early in the window is ignored in favor of a later space.
    const early = truncate(`ab\n${"c".repeat(80)} ${"d".repeat(60)}`, false, 100);
    expect(early.text.split("\n").slice(0, 2)).toEqual(["ab", "c".repeat(80)]);
  });

  it("formats home paths", () => {
    expect(collapseHome("/Users/me/bin/x", "/Users/me")).toBe("~/bin/x");
  });
});
