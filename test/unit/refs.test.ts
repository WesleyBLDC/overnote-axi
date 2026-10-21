import { describe, expect, it } from "vitest";

import { AxiError } from "../../src/errors.js";
import { MAX_CANDIDATES, parseRef, resolveNote, SUFFIX_ADVICE } from "../../src/store/refs.js";
import { createFakes, type Fakes } from "../fixtures/fakes.js";

const ID = "01JAB3K9QWAAAAAAAAAAAAAAAA";

function failure(run: () => unknown): AxiError {
  try {
    run();
  } catch (error) {
    if (error instanceof AxiError) return error;
    throw error;
  }
  throw new Error("expected an AxiError");
}

describe("parseRef", () => {
  it("parses every accepted form", () => {
    expect(parseRef("current")).toEqual({ kind: "current" });
    expect(parseRef(" CURRENT ")).toEqual({ kind: "current" });
    expect(parseRef(ID.toLowerCase())).toEqual({ kind: "id", id: ID });
    expect(parseRef("title:  Standup ")).toEqual({ kind: "title", title: "Standup" });
    expect(parseRef("Title:a:b")).toEqual({ kind: "title", title: "a:b" });
    expect(parseRef("3k9qwa")).toEqual({ kind: "fragment", fragment: "3K9QWA" });
  });

  it("rejects empty, short, and non id references with VALIDATION_ERROR and hints", () => {
    expect(failure(() => parseRef("  ")).code).toBe("VALIDATION_ERROR");
    const short = failure(() => parseRef("3K9QW"));
    expect(short.code).toBe("VALIDATION_ERROR");
    expect(short.message).toContain("at least 6");
    const words = failure(() => parseRef("my groceries"));
    expect(words.code).toBe("VALIDATION_ERROR");
    expect(words.suggestions).toEqual(['overnote-axi search "my groceries"', 'overnote-axi read "title:my groceries"']);
    expect(failure(() => parseRef("title:  ")).code).toBe("VALIDATION_ERROR");
    // U, I, L and O are never in a ULID.
    expect(failure(() => parseRef("standup")).code).toBe("VALIDATION_ERROR");
    expect(failure(() => parseRef(`${ID}0`)).code).toBe("VALIDATION_ERROR");
  });
});

describe("resolveNote", () => {
  const live = { allowTrashed: false };
  const any = { allowTrashed: true };
  const setup = (): Fakes => createFakes();

  it("resolves a full id, live or trashed by option", () => {
    const { store, reader } = setup();
    const note = store.add({ body: "A" });
    const gone = store.add({ body: "B", deletedAt: 5 });
    expect(resolveNote(reader, note.id.toLowerCase(), live).id).toBe(note.id);
    expect(resolveNote(reader, gone.id, any).id).toBe(gone.id);
    const trashed = failure(() => resolveNote(reader, gone.id, live));
    expect(trashed.code).toBe("NOTE_TRASHED");
    expect(trashed.message).toBe("note 'B' is in Recently Deleted");
    expect(trashed.suggestions).toEqual([`overnote-axi recover ${gone.id}`]);
    expect(failure(() => resolveNote(reader, "01JAB00000ZZZZZZZZZZZZZZZZ", any)).code).toBe("NOTE_NOT_FOUND");
  });

  it("resolves current, falling back to the newest live note", () => {
    const { store, reader } = setup();
    expect(failure(() => resolveNote(reader, "current", any)).code).toBe("NOTE_NOT_FOUND");
    const pinned = store.add({ body: "pinned", pinned: 1000, updatedAt: 10 });
    const newest = store.add({ body: "newest", updatedAt: 500 });
    store.add({ body: "older", updatedAt: 100 });
    expect(resolveNote(reader, "current", live).id).toBe(newest.id);
    store.currentNoteId = pinned.id;
    expect(resolveNote(reader, "current", live).id).toBe(pinned.id);
    const trashed = store.add({ body: "trashed", deletedAt: 1 });
    store.currentNoteId = trashed.id;
    expect(resolveNote(reader, "current", live).id).toBe(newest.id);
  });

  it("finds the newest live note even when it is pinned", () => {
    const { store, reader } = setup();
    store.add({ body: "plain", updatedAt: 100 });
    const pinned = store.add({ body: "pinned", pinned: 1000, updatedAt: 900 });
    expect(resolveNote(reader, "current", live).id).toBe(pinned.id);
  });

  it("resolves titles with live notes winning over trashed ones", () => {
    const { store, reader } = setup();
    const trashed = store.add({ body: "Standup", deletedAt: 3 });
    expect(resolveNote(reader, "title:standup", any).id).toBe(trashed.id);
    const note = store.add({ body: "Standup" });
    expect(resolveNote(reader, "title:STANDUP", live).id).toBe(note.id);
    store.add({ body: "Standup" });
    const ambiguous = failure(() => resolveNote(reader, "title:Standup", live));
    expect(ambiguous.code).toBe("AMBIGUOUS_NOTE");
    expect(ambiguous.details.candidates).toHaveLength(2);
    const missing = failure(() => resolveNote(reader, "title:Nope", live));
    expect(missing.code).toBe("NOTE_NOT_FOUND");
    expect(missing.message).toBe("no note matches 'title:Nope'");
    expect(missing.suggestions).toEqual(["overnote-axi search Nope", "overnote-axi list"]);
    const spaced = failure(() => resolveNote(reader, "title:Two words", { allowTrashed: true, command: "recover" }));
    expect(spaced.suggestions).toEqual(['overnote-axi search "Two words" --trash', "overnote-axi trash"]);
  });

  it("resolves a unique fragment and lists at most 5 candidates when several match", () => {
    const { store, reader } = setup();
    const notes = Array.from({ length: 7 }, (_, i) => store.add({ body: `Note ${i}` }));
    expect(resolveNote(reader, notes[3]!.id.slice(-6), live).id).toBe(notes[3]!.id);
    const error = failure(() => resolveNote(reader, "01JAB00000", live));
    expect(error.code).toBe("AMBIGUOUS_NOTE");
    expect(error.message).toBe(`'01JAB00000' matches 7 notes; showing ${MAX_CANDIDATES}; ${SUFFIX_ADVICE}`);
    expect(error.suggestions).toEqual(["overnote-axi read <id>"]);
    expect(failure(() => resolveNote(reader, "01JAB00000", { allowTrashed: true, command: "delete" })).suggestions).toEqual([
      "overnote-axi delete <id>",
    ]);
    const candidates = error.details.candidates as { id: string; title: string; state: string }[];
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(candidates[0]).toEqual({ id: notes[0]!.id, title: "Note 0", state: "live" });
    const missing = failure(() => resolveNote(reader, "ZZZZZZ", live));
    expect(missing.code).toBe("NOTE_NOT_FOUND");
    expect(missing.message).toBe("no note matches 'ZZZZZZ'");
    expect(missing.suggestions).toEqual(["overnote-axi list"]);
    expect(failure(() => resolveNote(reader, "ZZZZZZ", { allowTrashed: true, command: "recover" })).suggestions).toEqual([
      "overnote-axi trash",
    ]);
  });
});
