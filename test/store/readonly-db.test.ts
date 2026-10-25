import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markdownNoteLink, noteDeeplink } from "../../src/domain/deeplink.js";
import type { NotesReader } from "../../src/domain/types.js";
import { AxiError } from "../../src/errors.js";
import {
  openReader,
  ReadOnlyNotesDb,
  REQUIRED_COLUMNS,
  snippetAround,
  TESTED_SCHEMA_VERSION,
  updateHint,
} from "../../src/store/readonly-db.js";
import { assertIsolated } from "../fixtures/guard.js";
import { createNotesDb, type NotesDbFixture } from "../fixtures/notes-db.js";

function code(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AxiError ? error.code : "raw";
  }
}

/** The AxiError openReader throws on `file`. */
function openError(file: string, binPath?: string): AxiError {
  try {
    openReader(file, binPath)?.close();
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    return error as AxiError;
  }
  return expect.unreachable("openReader did not throw");
}

/** The raw read-only connection behind a reader, for checking the fixture's schema. */
function rawDb(reader: NotesReader): { prepare(sql: string): { all(...params: string[]): unknown[] } } {
  return (reader as unknown as { db: ReturnType<typeof rawDb> }).db;
}

describe("openReader", () => {
  let fixture: NotesDbFixture;
  afterEach(() => fixture?.cleanup());

  it("returns null when the database does not exist yet", () => {
    fixture = createNotesDb();
    expect(openReader(path.join(fixture.supportDir, "missing.sqlite"))).toBeNull();
  });

  it("opens read-only: writes fail even through the raw connection", () => {
    fixture = createNotesDb();
    fixture.add({ body: "hello" });
    fixture.close();
    const reader = openReader(fixture.database)!;
    expect(reader).toBeInstanceOf(ReadOnlyNotesDb);
    expect(reader.schemaVersion()).toBe(1);
    const db = (reader as unknown as { db: { exec(sql: string): void } }).db;
    expect(() => db.exec("DELETE FROM notes")).toThrow();
    expect(reader.counts().live).toBe(1);
    reader.close();
    reader.close();
  });

  it("reads while the writer connection is open (WAL)", () => {
    fixture = createNotesDb();
    fixture.add({ body: "first" });
    const reader = openReader(fixture.database)!;
    expect(reader.counts().live).toBe(1);
    fixture.add({ body: "second" });
    expect(reader.counts().live).toBe(2);
    reader.close();
  });

  it("builds a real schema 2 fixture: user_version 2 and the notes_fts table", () => {
    fixture = createNotesDb({ schema: 2 });
    fixture.close();
    const reader = openReader(fixture.database)!;
    expect(reader.schemaVersion()).toBe(2);
    const fts = rawDb(reader).prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all("notes_fts");
    expect(fts).toHaveLength(1);
    reader.close();
  });

  it("opens and lists a newer schema that keeps every required column", () => {
    expect(TESTED_SCHEMA_VERSION).toBe(2);
    fixture = createNotesDb({ schema: 2, userVersion: 3 });
    const note = fixture.add({ body: "Newer schema" });
    fixture.setCurrent(note.id);
    fixture.close();
    const reader = openReader(fixture.database)!;
    expect(reader.schemaVersion()).toBe(3);
    expect(reader.list({ limit: 10 }).items.map((item) => item.id)).toEqual([note.id]);
    expect(reader.search("newer", { limit: 10 }).total).toBe(1);
    expect(reader.currentNoteId()).toBe(note.id);
    reader.close();
  });

  it("refuses a newer schema without a required column, naming it, with the update hint", () => {
    fixture = createNotesDb({ userVersion: 3 });
    fixture.exec("ALTER TABLE notes DROP COLUMN text_fold");
    fixture.close();
    const error = openError(fixture.database, "/nonexistent/overnote-axi/dist/overnote-axi.js");
    expect(error.code).toBe("DATABASE_ERROR");
    expect(error.message).toBe("the notes database (schema 3) lacks columns this overnote-axi reads");
    expect(error.details).toEqual({ schema: 3, missing: "notes.text_fold" });
    expect(error.suggestions).toEqual([
      "overnote-axi status",
      "cd <overnote-axi checkout> && git pull --ff-only && npm run build && npm install -g .",
    ]);
  });

  it("names every column of a missing table, and gives no update hint for a tested schema", () => {
    fixture = createNotesDb({ schema: 2 });
    fixture.exec("DROP TABLE settings");
    fixture.close();
    const error = openError(fixture.database);
    expect(error.details).toEqual({ schema: 2, missing: "settings.key,settings.value" });
    expect(error.suggestions).toEqual(["overnote-axi status"]);
  });

  it("requires every column the queries use: the schema 1 columns, which later schemas keep", () => {
    expect(REQUIRED_COLUMNS).toEqual({
      notes: [
        "id",
        "title",
        "text",
        "markdown",
        "raw_content",
        "title_fold",
        "text_fold",
        "pinned",
        "created_at",
        "updated_at",
        "deleted_at",
        "last_accessed_at",
        "caret_position",
      ],
      settings: ["key", "value"],
    });
  });

  it("still refuses user_version 0", () => {
    fixture = createNotesDb({ userVersion: 0 });
    fixture.close();
    const error = openError(fixture.database);
    expect(error.code).toBe("DATABASE_ERROR");
    expect(error.details).toEqual({ schema: 0 });
    expect(error.message).toContain("schema 0");
    expect(error.suggestions).toEqual(["overnote-axi status", "overnote-axi open"]);
  });

  it("refuses a file that is not an Overnote database or not SQLite at all", () => {
    fixture = createNotesDb({ noSchema: true });
    fixture.close();
    expect(code(() => openReader(fixture.database))).toBe("DATABASE_ERROR");
    const junk = path.join(fixture.supportDir, "junk.sqlite");
    writeFileSync(junk, "this is not a database, just text that is long enough to have a header");
    expect(code(() => openReader(junk))).toBe("DATABASE_ERROR");
    const dir = path.join(fixture.supportDir, "dir.sqlite");
    mkdirSync(dir);
    expect(code(() => openReader(dir))).toBe("DATABASE_ERROR");
  });
});

describe.each([1, 2] as const)("ReadOnlyNotesDb queries on schema %i", (schema) => {
  let fixture: NotesDbFixture;
  let reader: NotesReader;
  const open = () => {
    reader = openReader(fixture.database)!;
    return reader;
  };

  beforeEach(() => {
    fixture = createNotesDb({ schema });
  });
  afterEach(() => {
    reader?.close();
    fixture.cleanup();
  });

  it("states zero for an empty database", () => {
    open();
    expect(reader.counts()).toEqual({ live: 0, pinned: 0, trashed: 0 });
    expect(reader.list({ limit: 10 })).toEqual({ items: [], total: 0 });
    expect(reader.listTrashed({ limit: 10 })).toEqual({ items: [], total: 0 });
    expect(reader.search("x", { limit: 10 })).toEqual({ items: [], total: 0 });
    expect(reader.currentNoteId()).toBeNull();
    expect(reader.get("01JAB00000AAAAAAAAAAAAAAAA")).toBeNull();
  });

  it("counts live, pinned and trashed notes", () => {
    fixture.add({ body: "a", pinned: 1000 });
    fixture.add({ body: "b" });
    fixture.add({ body: "c", deletedAt: 5 });
    open();
    expect(reader.counts()).toEqual({ live: 2, pinned: 1, trashed: 1 });
  });

  it("lists in app order: pins first, then the order column desc, then id", () => {
    const old = fixture.add({ body: "old", updatedAt: 100, createdAt: 900, lastAccessedAt: 500 });
    const fresh = fixture.add({ body: "fresh", updatedAt: 300, createdAt: 100, lastAccessedAt: null });
    const pinB = fixture.add({ body: "pin b", pinned: 2000, updatedAt: 1 });
    const pinA = fixture.add({ body: "pin a", pinned: 1000, updatedAt: 2 });
    const tieX = fixture.add({ id: "01JAB00000ZZZZZZZZZZZZZZZ1", body: "tie", updatedAt: 200, createdAt: 1, lastAccessedAt: 1 });
    const tieY = fixture.add({ id: "01JAB00000ZZZZZZZZZZZZZZZ0", body: "tie", updatedAt: 200, createdAt: 1, lastAccessedAt: 1 });
    fixture.add({ body: "gone", deletedAt: 10, updatedAt: 999 });
    open();
    const ids = (order?: "updated" | "accessed" | "created") => reader.list({ limit: 50, order }).items.map((n) => n.id);
    expect(ids()).toEqual([pinA.id, pinB.id, fresh.id, tieY.id, tieX.id, old.id]);
    expect(ids("created")).toEqual([pinA.id, pinB.id, old.id, fresh.id, tieY.id, tieX.id]);
    expect(ids("accessed")).toEqual([pinA.id, pinB.id, old.id, tieY.id, tieX.id, fresh.id]);
    const page = reader.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(6);
    expect(page.items.map((n) => n.id)).toEqual([fresh.id, tieY.id]);
    expect(reader.list({ limit: 50, pinnedOnly: true })).toMatchObject({ total: 2, items: [{ id: pinA.id }, { id: pinB.id }] });
    expect(reader.list({ limit: 0 })).toEqual({ items: [], total: 6 });
  });

  it("maps summaries: code point counts, a 200 char preview, nullable fields", () => {
    const text = `😀${"x".repeat(250)}`;
    const note = fixture.add({ title: "T", text, markdown: text, lastAccessedAt: null });
    open();
    const [row] = reader.list({ limit: 1 }).items;
    expect(row).toEqual({
      id: note.id,
      title: "T",
      preview: Array.from(text).slice(0, 200).join(""),
      charCount: 251,
      pinned: null,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      deletedAt: null,
      lastAccessedAt: null,
    });
  });

  it("lists Recently Deleted, most recently deleted first", () => {
    const a = fixture.add({ body: "a", deletedAt: 100 });
    const b = fixture.add({ body: "b", deletedAt: 300 });
    const c = fixture.add({ body: "c", deletedAt: 200 });
    fixture.add({ body: "live" });
    open();
    expect(reader.listTrashed({ limit: 10 }).items.map((n) => n.id)).toEqual([b.id, c.id, a.id]);
    expect(reader.listTrashed({ limit: 1, offset: 1 })).toMatchObject({ total: 3, items: [{ id: c.id }] });
  });

  it("gets any note by id, case-insensitively, with every stored field", () => {
    const note = fixture.add({ body: "# Hi\nthere", rawContent: '{"type":"doc"}', caretPosition: 3, deletedAt: 7 });
    open();
    expect(reader.get(note.id.toLowerCase())).toEqual(note);
  });

  it("searches folded title and text, title hits first, then pins, then newest", () => {
    const textOnly = fixture.add({ title: "Weekly sync", text: "Weekly sync\nWe moved the standup to 9:30 so Sam can join", updatedAt: 500 });
    const titleOld = fixture.add({ title: "Standup", text: "Standup\nnotes", updatedAt: 100 });
    const titleNew = fixture.add({ title: "Stándup two", text: "Stándup two", updatedAt: 200 });
    const pinnedText = fixture.add({ title: "Pinned", text: "Pinned\nSTANDUP later", pinned: 1000, updatedAt: 1 });
    fixture.add({ title: "Other", text: "Other\nnothing" });
    fixture.add({ title: "Trashed standup", text: "Trashed standup", deletedAt: 9 });
    open();
    const page = reader.search("  standup ", { limit: 10 });
    expect(page.total).toBe(4);
    expect(page.items.map((hit) => [hit.note.id, hit.titleMatch])).toEqual([
      [titleNew.id, true],
      [titleOld.id, true],
      [pinnedText.id, false],
      [textOnly.id, false],
    ]);
    expect(page.items[3]!.snippet).toBe("Weekly sync We moved the standup to 9:30 so Sam can join");
    expect(reader.search("standup", { limit: 1 })).toMatchObject({ total: 4, items: [{ note: { id: titleNew.id } }] });
    expect(reader.search("standup", { limit: 10, trashed: true }).items.map((hit) => hit.note.title)).toEqual(["Trashed standup"]);
    expect(reader.search("   ", { limit: 10 })).toEqual({ items: [], total: 0 });
  });

  it("treats LIKE wildcards in the query literally", () => {
    fixture.add({ body: "100% done" });
    fixture.add({ body: "1000 done" });
    fixture.add({ body: "a_b" });
    fixture.add({ body: "axb" });
    open();
    expect(reader.search("100%", { limit: 10 }).items.map((hit) => hit.note.title)).toEqual(["100% done"]);
    expect(reader.search("a_b", { limit: 10 }).items.map((hit) => hit.note.title)).toEqual(["a_b"]);
  });

  it("uses the display title for title matches when the stored title is empty", () => {
    const untitled = fixture.add({ title: "", text: "\n\nFirst line here\nsecond" });
    const blank = fixture.add({ title: "", text: "" });
    open();
    expect(reader.search("first", { limit: 5 }).items).toEqual([
      expect.objectContaining({ note: expect.objectContaining({ id: untitled.id }), titleMatch: true }),
    ]);
    expect(reader.search("second", { limit: 5 }).items[0]).toMatchObject({ titleMatch: false });
    expect(reader.search("untitled", { limit: 5 }).items).toEqual([
      expect.objectContaining({ note: expect.objectContaining({ id: blank.id }), titleMatch: true, snippet: "" }),
    ]);
  });

  it("confirms title matches with displayTitle when the text starts with Unicode whitespace", () => {
    const lead = fixture.add({ title: "", text: "\u00a0\nAgenda notes\nmore", updatedAt: 10 });
    const nbspTitle = fixture.add({ title: "\u00a0", text: "Agenda for Monday", updatedAt: 20 });
    // U+2028 survives folding, so only the displayTitle check sees past it.
    const separator = fixture.add({ title: "", text: "\u2028\nAgenda later", updatedAt: 5 });
    const body = fixture.add({ title: "Other", text: "the agenda is long", updatedAt: 30 });
    open();
    expect(reader.search("agenda", { limit: 10 }).items.map((hit) => [hit.note.id, hit.titleMatch])).toEqual([
      [nbspTitle.id, true],
      [lead.id, true],
      [separator.id, true],
      [body.id, false],
    ]);
  });

  it("finds notes by id prefix or suffix, live first", () => {
    const live = fixture.add({ id: "01JAB00000AAAAAAAAAAQWERTY", body: "live" });
    const trashed = fixture.add({ id: "01JAB00000BBBBBBBBBBQWERTY", body: "trashed", deletedAt: 5, updatedAt: 99_999_999_999_999 });
    const other = fixture.add({ id: "01JAC11111CCCCCCCCCCCCCCCC", body: "other" });
    open();
    expect(reader.findByIdFragment("qwerty", 10).items.map((n) => n.id)).toEqual([live.id, trashed.id]);
    expect(reader.findByIdFragment("01jac1", 10).items.map((n) => n.id)).toEqual([other.id]);
    expect(reader.findByIdFragment("QWERTY", 1)).toMatchObject({ items: [{ id: live.id }], total: 2 });
    expect(reader.findByIdFragment("ZZZZZZ", 10)).toEqual({ items: [], total: 0 });
    expect(reader.findByIdFragment("01JA%_", 10)).toEqual({ items: [], total: 0 });
  });

  it("finds notes by folded display title, live first", () => {
    const trashed = fixture.add({ title: "Café", text: "Café", deletedAt: 5, updatedAt: 9_000_000_000_000 });
    const live = fixture.add({ title: "CAFE", text: "CAFE" });
    const untitled = fixture.add({ title: "", text: "  cafe  \nmore" });
    fixture.add({ title: "Cafeteria", text: "Cafeteria" });
    fixture.add({ title: "Menu", text: "Menu\ncafe is mentioned" });
    const blank = fixture.add({ title: "", text: "" });
    open();
    expect(reader.findByTitle(" cafe ", 10).map((n) => n.id)).toEqual([untitled.id, live.id, trashed.id]);
    expect(reader.findByTitle("cafe", 1).map((n) => n.id)).toEqual([untitled.id]);
    expect(reader.findByTitle("Untitled", 10).map((n) => n.id)).toEqual([blank.id]);
    expect(reader.findByTitle("", 10)).toEqual([]);
  });

  it("reads currentNoteId from settings only while the note exists and the value is a JSON string", () => {
    const note = fixture.add({ body: "x" });
    fixture.setCurrent(note.id);
    open();
    expect(reader.currentNoteId()).toBe(note.id);
    reader.close();
    fixture.setCurrent("01JAB00000NOTEXISTINGNOTE0");
    open();
    expect(reader.currentNoteId()).toBeNull();
    reader.close();
    // Not JSON: the helper reads no current note here and the app falls back to the newest live note.
    fixture.exec(`UPDATE settings SET value = '${note.id}' WHERE key = 'currentNoteId'`);
    open();
    expect(reader.currentNoteId()).toBeNull();
    reader.close();
    fixture.exec(`UPDATE settings SET value = '""' WHERE key = 'currentNoteId'`);
    open();
    expect(reader.currentNoteId()).toBeNull();
    reader.close();
    fixture.exec(`UPDATE settings SET value = '42' WHERE key = 'currentNoteId'`);
    open();
    expect(reader.currentNoteId()).toBeNull();
  });

  it("confirms backlinks by decoding links, not by mentions", () => {
    const target = fixture.add({ body: "Target" });
    const encoded = fixture.add({ body: "a", markdown: `see ${markdownNoteLink("Target", target.id)}`, updatedAt: 10 });
    const raw = fixture.add({
      body: "b",
      markdown: `[t](raycast://extensions/wesleybldc/overnote/toggle-notes?context={"id":"${target.id}"})`,
      updatedAt: 20,
    });
    const pinned = fixture.add({ body: "c", markdown: noteDeeplink(target.id), pinned: 1000, updatedAt: 1 });
    fixture.add({ body: "mention", markdown: `toggle-notes?context= mentions ${target.id} only` });
    fixture.add({ body: "trashed", markdown: noteDeeplink(target.id), deletedAt: 3 });
    fixture.add({ body: "other", markdown: noteDeeplink("01JAB00000OTHERNOTE0000000") });
    open();
    expect(reader.backlinks(target.id).map((n) => n.id)).toEqual([pinned.id, raw.id, encoded.id]);
    expect(reader.backlinks(encoded.id)).toEqual([]);
  });

  it("runs a command's reads in one snapshot, nested snapshots included", () => {
    fixture.add({ body: "one" });
    open();
    const result = reader.snapshot((inner) => {
      const before = inner.counts().live;
      fixture.add({ body: "two" });
      const nested = inner.snapshot((again) => again.list({ limit: 10 }).total);
      return { before, after: inner.counts().live, nested };
    });
    expect(result).toEqual({ before: 1, after: 1, nested: 1 });
    expect(reader.counts().live).toBe(2);
  });

  it("ends the snapshot and rethrows when the read fails", () => {
    open();
    expect(() =>
      reader.snapshot(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(reader.snapshot((inner) => inner.counts().live)).toBe(0);
  });

  it("translates SQLite failures after open into DATABASE_ERROR", () => {
    open();
    reader.close();
    expect(code(() => reader.counts())).toBe("DATABASE_ERROR");
    expect(code(() => reader.snapshot(() => 1))).toBe("DATABASE_ERROR");
  });
});

describe("snippetAround", () => {
  it("cuts about 80 code points around the folded match on one line", () => {
    const text = `${"a".repeat(100)}\n\nNeedle  here ${"b".repeat(100)}`;
    const snippet = snippetAround(text, "needle");
    expect(snippet.startsWith("a")).toBe(true);
    expect(snippet).toContain("Needle here");
    expect(Array.from(snippet).length).toBeLessThanOrEqual(80);
  });

  it("maps folded positions back to the original text", () => {
    expect(snippetAround("ﬁne Crème brûlée", "brulee")).toBe("ﬁne Crème brûlée");
    expect(snippetAround("nothing", "zzz")).toBe("");
  });
});

describe("updateHint", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "overnote-axi-hint-")));
    assertIsolated(root, "update hint dir");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A package at `<root>/<name>` with a built dist/overnote-axi.js, and a bin link to it. */
  function install(name: string, checkout: boolean): { pkg: string; bin: string } {
    const pkg = path.join(root, name);
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(path.join(pkg, "dist", "overnote-axi.js"), "#!/usr/bin/env node\n");
    if (checkout) mkdirSync(path.join(pkg, ".git"));
    const bin = path.join(root, `${name}-bin`);
    symlinkSync(path.join(pkg, "dist", "overnote-axi.js"), bin);
    return { pkg, bin };
  }

  it("pulls and rebuilds the checkout a linked install runs from, quoting its path", () => {
    const { pkg, bin } = install("my checkout", true);
    expect(updateHint(bin)).toBe(`git -C "${pkg}" pull --ff-only && npm --prefix "${pkg}" run build`);
    const plain = install("overnote-axi", true);
    expect(updateHint(plain.bin)).toBe(`git -C ${plain.pkg} pull --ff-only && npm --prefix ${plain.pkg} run build`);
  });

  it("rebuilds and reinstalls from the checkout for a copied install or an unknown path", () => {
    const { bin } = install("copied", false);
    const copied = "cd <overnote-axi checkout> && git pull --ff-only && npm run build && npm install -g .";
    expect(updateHint(bin)).toBe(copied);
    expect(updateHint(path.join(root, "missing.js"))).toBe(copied);
  });
});
