import { describe, expect, it } from "vitest";

import {
  collapseHome,
  column,
  renderEmpty,
  renderError,
  renderHelp,
  renderList,
  renderTextBlock,
  relativeTime,
  truncate,
} from "../../src/output/render.js";

describe("render", () => {
  it("renders a list with its aggregate count", () => {
    const items = [{ id: "01A", title: "One" }];
    const columns = [column<(typeof items)[number]>("id", (item) => item.id), column("title", (item: (typeof items)[number]) => item.title)];
    expect(renderList("notes", items, columns, { total: 40, noun: "live notes" })).toBe(
      "count: 1 of 40 live notes\nnotes[1]{id,title}:\n  01A,One",
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
    expect(result).toEqual({ text: "xxxxxxxxxx\n... (truncated, 20 chars total)", truncated: true, total: 20 });
    expect(truncate("short", false, 10).truncated).toBe(false);
  });

  it("formats ages and home paths", () => {
    expect(relativeTime(0, 90_000)).toBe("1m");
    expect(collapseHome("/Users/me/bin/x", "/Users/me")).toBe("~/bin/x");
  });
});
