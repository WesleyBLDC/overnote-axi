import { describe, expect, it } from "vitest";

import {
  backlinkLikePattern,
  contextNoteId,
  escapeLike,
  extractNoteLinks,
  markdownNoteLink,
  noteDeeplink,
  openNotesDeeplink,
} from "../../src/domain/deeplink.js";

const A = "01JAB3K9QWAAAAAAAAAAAAAAAA";
const B = "01JA7Q2M1CBBBBBBBBBBBBBBBB";
const C = "01J9ZT4E8DCCCCCCCCCCCCCCCC";

describe("deeplinks", () => {
  it("builds the toggle-notes and open-notes links the app uses", () => {
    expect(noteDeeplink(A)).toBe(
      `raycast://extensions/wesleybldc/overnote/toggle-notes?context=%7B%22id%22%3A%22${A}%22%7D`,
    );
    expect(openNotesDeeplink()).toBe("raycast://extensions/wesleybldc/overnote/open-notes");
  });

  it("renders a markdown link with the label escaped", () => {
    expect(markdownNoteLink("Groceries", A)).toBe(`[Groceries](${noteDeeplink(A)})`);
    expect(markdownNoteLink("a [b] \\ c", A)).toBe(`[a \\[b\\] \\\\ c](${noteDeeplink(A)})`);
  });

  it("round trips a link through extractNoteLinks", () => {
    expect(extractNoteLinks(markdownNoteLink("a [b] \\ c", A))).toEqual([{ id: A, label: "a [b] \\ c" }]);
  });

  it("finds encoded, raw JSON, bare and autolinked deeplinks in order without duplicates", () => {
    const markdown = [
      `See [Groceries](${noteDeeplink(A)}) and`,
      `[raw](raycast://extensions/wesleybldc/overnote/toggle-notes?context={"id": "${B.toLowerCase()}"})`,
      `bare ${noteDeeplink(C)} end`,
      `again [dup](${noteDeeplink(A)})`,
      `<${noteDeeplink(C)}>`,
    ].join("\n");
    expect(extractNoteLinks(markdown)).toEqual([
      { id: A, label: "Groceries" },
      { id: B, label: "raw" },
      { id: C, label: "" },
    ]);
  });

  it("ignores other links, invalid contexts and mere mentions of an id", () => {
    const markdown = [
      `mention ${A}`,
      "[web](https://example.com)",
      "[bad](raycast://extensions/wesleybldc/overnote/toggle-notes?context=%7Bnot-json)",
      '[no id](raycast://extensions/wesleybldc/overnote/toggle-notes?context=%7B%22x%22%3A1%7D)',
      '[short](raycast://extensions/wesleybldc/overnote/toggle-notes?context=%7B%22id%22%3A%22ABC%22%7D)',
      "[other ext](raycast://extensions/someone/else/toggle-notes?context=%7B%7D)",
    ].join("\n");
    expect(extractNoteLinks(markdown)).toEqual([]);
    expect(extractNoteLinks("")).toEqual([]);
  });

  it("reads the id from a context with extra query parameters or double encoding", () => {
    expect(contextNoteId(`${encodeURIComponent(JSON.stringify({ id: A }))}&launchType=background`)).toBe(A);
    expect(contextNoteId(encodeURIComponent(encodeURIComponent(JSON.stringify({ id: A }))))).toBe(A);
    expect(contextNoteId("null")).toBeNull();
    expect(contextNoteId("%E0%A4%A")).toBeNull();
  });

  it("builds an escaped LIKE prefilter", () => {
    expect(backlinkLikePattern(A)).toBe(`%toggle-notes?context=%${A}%`);
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
