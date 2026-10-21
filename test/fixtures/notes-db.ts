/**
 * Builds a `notes.sqlite` with the helper's schema (overnote docs/architecture.md section 6) in a
 * fresh temp support dir, for read path tests without the helper. Only this fixture writes to a
 * database, and only to its own temp file: the CLI itself never writes SQLite.
 *
 * Seeds follow FakeNoteInput (test/fixtures/fakes.ts): `body` is a shortcut for markdown, text
 * and title, and the folded columns are derived with core's fold, as the helper does.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fold } from "@overnote/core/text";

import type { Note, NoteId } from "../../src/domain/types.js";
import { loadSqlite } from "../../src/store/readonly-db.js";
import { fakeId, type FakeNoteInput } from "./fakes.js";
import { assertIsolated } from "./guard.js";

type DatabaseSync = InstanceType<ReturnType<typeof loadSqlite>["DatabaseSync"]>;

/** Schema version 1, verbatim from overnote docs/architecture.md section 6. */
export const SCHEMA_V1 = `
CREATE TABLE notes (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  text             TEXT NOT NULL DEFAULT '',
  markdown         TEXT NOT NULL DEFAULT '',
  raw_content      TEXT NOT NULL,
  title_fold       TEXT NOT NULL DEFAULT '',
  text_fold        TEXT NOT NULL DEFAULT '',
  pinned           REAL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  last_accessed_at INTEGER,
  caret_position   INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX notes_list_order   ON notes (deleted_at, pinned, updated_at DESC, id);
CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

export const EMPTY_DOC = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });

export interface NotesDbOptions {
  /** `PRAGMA user_version`; default 1. */
  userVersion?: number;
  /** Leave the schema out (an empty SQLite file that is not an Overnote database). */
  noSchema?: boolean;
}

/** A temp support dir with a writable notes.sqlite. Call `cleanup()` in afterEach. */
export class NotesDbFixture {
  readonly root: string;
  readonly supportDir: string;
  readonly database: string;
  /** Advances by one second per seeded note, so insertion order is update order by default. */
  clock = 1_792_000_000_000;
  private readonly db: DatabaseSync;
  private counter = 0;

  constructor(options: NotesDbOptions = {}) {
    this.root = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-db-"));
    this.supportDir = path.join(this.root, "support");
    this.database = path.join(this.supportDir, "notes.sqlite");
    assertIsolated(this.supportDir, "fixture support dir");
    mkdirSync(this.supportDir, { mode: 0o700 });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(this.database);
    this.db.exec("PRAGMA journal_mode = WAL");
    if (!options.noSchema) this.db.exec(SCHEMA_V1);
    this.db.exec(`PRAGMA user_version = ${Math.trunc(options.userVersion ?? 1)}`);
  }

  /** Environment that points the CLI at this support dir. */
  env(): Record<string, string> {
    return { OVERNOTE_SUPPORT_DIR: this.supportDir };
  }

  now(): number {
    this.clock += 1000;
    return this.clock;
  }

  /** Inserts a note the way the helper stores it and returns it. */
  add(input: FakeNoteInput = {}): Note {
    const body = input.body ?? "";
    const text = input.text ?? body.replace(/^#+\s*/gm, "");
    const at = input.createdAt ?? this.now();
    const note: Note = {
      id: input.id ?? fakeId(++this.counter),
      rawContent: input.rawContent ?? EMPTY_DOC,
      markdown: input.markdown ?? body,
      text,
      title: input.title ?? (text.split("\n")[0] ?? "").trim(),
      pinned: input.pinned ?? null,
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
      deletedAt: input.deletedAt ?? null,
      lastAccessedAt: input.lastAccessedAt === undefined ? at : input.lastAccessedAt,
      caretPosition: input.caretPosition ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned,
                            created_at, updated_at, deleted_at, last_accessed_at, caret_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        note.id,
        note.title,
        note.text,
        note.markdown,
        note.rawContent,
        fold(note.title),
        fold(note.text),
        note.pinned,
        note.createdAt,
        note.updatedAt,
        note.deletedAt,
        note.lastAccessedAt,
        note.caretPosition,
      );
    return note;
  }

  /** Persists the current note id as the helper does (a JSON string in `settings`). */
  setCurrent(id: NoteId | null): void {
    if (id === null) {
      this.db.prepare("DELETE FROM settings WHERE key = 'currentNoteId'").run();
      return;
    }
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('currentNoteId', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(id));
  }

  /** Raw SQL against the fixture, for edge cases such as a malformed settings value. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Closes the writing connection (the WAL is checkpointed and removed, as after the helper quits). */
  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  cleanup(): void {
    this.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function createNotesDb(options: NotesDbOptions = {}): NotesDbFixture {
  return new NotesDbFixture(options);
}
