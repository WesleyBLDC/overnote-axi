/**
 * Read-only access to Overnote's database with node:sqlite.
 *
 * Port of overnote src/domain/readonly-db.ts: opened with `readOnly: true`, `PRAGMA query_only`,
 * and a short busy timeout, every query parameterized. Ordering and matching mirror the helper
 * (architecture.md section 5): pinned key asc first, then the order column desc, then id asc;
 * filters fold with @overnote/core/text `fold` and match `title_fold` / `text_fold` with an
 * escaped LIKE. Loading node:sqlite mutes only its ExperimentalWarning.
 *
 * - On open, `PRAGMA user_version` must be 1 or newer and the tables must carry every column in
 *   REQUIRED_COLUMNS (probed with `pragma_table_xinfo`); otherwise DATABASE_ERROR names the
 *   missing columns, so queries never run on columns that are gone. A newer schema that keeps
 *   them opens: Overnote's schema changes so far are additive, and its own read-only fallback
 *   checks no version either.
 * - `snapshot()` wraps one command's reads in a deferred read transaction (one WAL snapshot).
 * - `backlinks()` uses LIKE only as a prefilter (`%toggle-notes?context=%<id>%`, with `%`, `_`
 *   and `\` escaped); it scans the table (no index helps a leading wildcard), then confirms each
 *   candidate with extractNoteLinks, which decodes the context, so differently encoded links match.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { displayTitle, fold } from "@overnote/core/text";

import { shellQuote } from "../args.js";
import { backlinkLikePattern, escapeLike, extractNoteLinks } from "../domain/deeplink.js";
import type {
  ListOrder,
  ListQuery,
  Note,
  NoteCounts,
  NoteId,
  NoteSummary,
  NotesReader,
  Page,
  SearchHit,
  SearchQuery,
  TrashQuery,
} from "../domain/types.js";
import { AxiError, axiError } from "../errors.js";

/**
 * The newest schema version this build was tested with (overnote docs/architecture.md section 6).
 * A newer one still opens when it keeps REQUIRED_COLUMNS; `status` and `home` then say to update.
 */
export const TESTED_SCHEMA_VERSION = 2;

/** Whether `schema` is newer than the newest one this build was tested with. */
export function newerSchema(schema: number): boolean {
  return schema > TESTED_SCHEMA_VERSION;
}

/** Characters of plain text around a search match (SearchHit.snippet). */
export const SNIPPET_LENGTH = 80;
/** How far before the match a snippet starts. */
const SNIPPET_LEAD = 30;

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;
type SqlValue = string | number | null;
type Row = Record<string, unknown>;

/** The whitespace SQL `trim()` strips, matching what `String.trim()` strips for typical notes. */
const WS = "' ' || char(9) || char(10) || char(13)";

const SUMMARY_COLUMNS = `id, title, substr(text, 1, 200) AS preview, length(text) AS char_count, pinned,
  created_at, updated_at, deleted_at, last_accessed_at`;

const APP_ORDER = "pinned IS NULL, pinned ASC";

const ORDER_COLUMN: Readonly<Record<ListOrder, string>> = {
  updated: "updated_at",
  accessed: "last_accessed_at",
  created: "created_at",
};

/**
 * Whether the folded query (?1, a LIKE pattern) occurs in the display title, computed the way
 * core's displayTitle derives it: the stored title, else the first non-empty line of text, else
 * "Untitled". It reads the folded columns, whose NFKD folding turns NBSP and the other
 * compatibility spaces into plain spaces, but SQLite's trim still strips only the ASCII
 * whitespace in WS, while displayTitle uses String.trim, which strips all Unicode whitespace
 * (U+2028 or U+FEFF, for example). So this is a prefilter and sort key only, and search()
 * confirms each returned hit with displayTitle.
 */
const TITLE_MATCH = `CASE
    WHEN trim(title_fold, ${WS}) <> '' THEN title_fold LIKE ?1 ESCAPE '\\'
    WHEN trim(text_fold, ${WS}) <> '' THEN substr(ltrim(text_fold, ${WS}), 1,
      instr(ltrim(text_fold, ${WS}) || char(10), char(10)) - 1) LIKE ?1 ESCAPE '\\'
    ELSE 'untitled' LIKE ?1 ESCAPE '\\'
  END`;

/**
 * Every column the queries in this file select, filter, or sort on, per table: SUMMARY_COLUMNS,
 * TITLE_MATCH and search (`title_fold`, `text_fold`), get (`markdown`, `raw_content`,
 * `caret_position`), findByTitle, backlinks (`markdown`), and currentNoteId (`settings`).
 * Add a column here when a query starts using it.
 */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
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
};

let sqliteModule: SqliteModule | null = null;

/**
 * Loads `node:sqlite` on first use while muting its one-time ExperimentalWarning, which would
 * otherwise reach stderr on every run. Other warnings pass through.
 */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const name = typeof warning === "string" ? type : warning.name;
    if (name === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

function databaseError(message = "could not read the Overnote database"): AxiError {
  return axiError(message, "DATABASE_ERROR", ["overnote-axi status"]);
}

/**
 * The command that updates this overnote-axi, as one line to paste. `binPath` is the running
 * script; two levels up from its real path is the package root. A root with `.git` is a checkout,
 * which a linked install (`npm install -g .`, npm's default for a folder) runs from, so pulling
 * and rebuilding it updates the global command. Otherwise the install is a copy, rebuilt in the
 * checkout and installed again.
 */
export function updateHint(binPath: string): string {
  let root: string | null;
  try {
    root = path.dirname(path.dirname(realpathSync(binPath)));
  } catch {
    root = null;
  }
  if (root && existsSync(path.join(root, ".git"))) {
    const quoted = shellQuote(root);
    return `git -C ${quoted} pull --ff-only && npm --prefix ${quoted} run build`;
  }
  return "cd <overnote-axi checkout> && git pull --ff-only && npm run build && npm install -g .";
}

function unsupportedSchema(version: number): AxiError {
  return axiError(
    `the notes database reports schema ${version}, and Overnote schemas start at 1`,
    "DATABASE_ERROR",
    ["overnote-axi status", "overnote-axi open"],
    { schema: version },
  );
}

function missingColumnsError(version: number, missing: string[], binPath: string): AxiError {
  return axiError(
    `the notes database (schema ${version}) lacks columns this overnote-axi reads`,
    "DATABASE_ERROR",
    // Only a newer schema can be fixed by updating; an older one without these columns is not a
    // database Overnote wrote.
    newerSchema(version) ? ["overnote-axi status", updateHint(binPath)] : ["overnote-axi status"],
    { schema: version, missing: missing.join(",") },
  );
}

/** `<table>.<column>` for each REQUIRED_COLUMNS entry the database lacks (a missing table lacks all). */
function missingColumns(db: DatabaseSync): string[] {
  const missing: string[] = [];
  // table_xinfo, unlike table_info, also lists generated columns, in case a later schema derives
  // one of these.
  const probe = db.prepare("SELECT name FROM pragma_table_xinfo(?)");
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set((probe.all(table) as Row[]).map((row) => String(row.name)));
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  return missing;
}

/**
 * Opens the database, or returns null when the file does not exist yet.
 * Throws DATABASE_ERROR (never a raw SQLite message) when it exists but cannot be read.
 * `binPath`, the running script, only feeds the update hint of a newer schema that lacks columns.
 */
export function openReader(file: string, binPath: string = process.argv[1] ?? ""): NotesReader | null {
  if (!existsSync(file)) return null;
  let isFile: boolean;
  try {
    isFile = statSync(file).isFile();
  } catch {
    throw databaseError();
  }
  if (!isFile) throw databaseError("The Overnote database path is not a file");
  let db: DatabaseSync;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw databaseError();
  }
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 1000");
    const version = Number((db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0);
    if (!Number.isInteger(version) || version < 1) throw unsupportedSchema(version);
    // A file that is not an Overnote database, or a schema without a column the queries use,
    // fails here, not mid command.
    const missing = missingColumns(db);
    if (missing.length > 0) throw missingColumnsError(version, missing, binPath);
    return new ReadOnlyNotesDb(db, version);
  } catch (error) {
    db.close();
    throw error instanceof AxiError ? error : databaseError();
  }
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toSummary(row: Row): NoteSummary {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    preview: String(row.preview ?? ""),
    charCount: Number(row.char_count ?? 0),
    pinned: nullableNumber(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: nullableNumber(row.deleted_at),
    lastAccessedAt: nullableNumber(row.last_accessed_at),
  };
}

function toNote(row: Row): Note {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    text: String(row.text ?? ""),
    markdown: String(row.markdown ?? ""),
    rawContent: String(row.raw_content ?? ""),
    pinned: nullableNumber(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: nullableNumber(row.deleted_at),
    lastAccessedAt: nullableNumber(row.last_accessed_at),
    caretPosition: nullableNumber(row.caret_position),
  };
}

function bounds(limit: number, offset = 0): [number, number] {
  return [Math.max(0, Math.trunc(limit)), Math.max(0, Math.trunc(offset))];
}

/** A LIKE pattern for the folded query as a literal substring. */
function substringPattern(folded: string): string {
  return `%${escapeLike(folded)}%`;
}

/**
 * About SNIPPET_LENGTH code points of `text` around the first folded match of `needle`, on one
 * line, or "" when the text does not contain it. Folding can change lengths (NFKD), so the match
 * is found on a per character fold that maps back to the original text.
 */
export function snippetAround(text: string, needle: string): string {
  const chars = Array.from(text);
  let folded = "";
  const owner: number[] = [];
  chars.forEach((char, index) => {
    const part = fold(char);
    folded += part;
    for (let i = 0; i < part.length; i++) owner.push(index);
  });
  const at = folded.indexOf(needle);
  if (at === -1) return "";
  const start = Math.max(0, (owner[at] ?? 0) - SNIPPET_LEAD);
  return chars
    .slice(start, start + SNIPPET_LENGTH)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The class behind openReader, exported for tests. */
export class ReadOnlyNotesDb implements NotesReader {
  private depth = 0;
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly version: number,
  ) {}

  /** Runs a query, turning any SQLite failure into DATABASE_ERROR. */
  private all(sql: string, ...params: SqlValue[]): Row[] {
    try {
      return this.db.prepare(sql).all(...params) as Row[];
    } catch {
      throw databaseError();
    }
  }

  private one(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.all(sql, ...params)[0];
  }

  private count(sql: string, ...params: SqlValue[]): number {
    return Number(this.one(sql, ...params)?.count ?? 0);
  }

  counts(): NoteCounts {
    const row = this.one(
      `SELECT
         coalesce(sum(deleted_at IS NULL), 0) AS live,
         coalesce(sum(deleted_at IS NULL AND pinned IS NOT NULL), 0) AS pinned,
         coalesce(sum(deleted_at IS NOT NULL), 0) AS trashed
       FROM notes`,
    );
    return { live: Number(row?.live ?? 0), pinned: Number(row?.pinned ?? 0), trashed: Number(row?.trashed ?? 0) };
  }

  list(query: ListQuery): Page<NoteSummary> {
    const [limit, offset] = bounds(query.limit, query.offset);
    const where = query.pinnedOnly ? "deleted_at IS NULL AND pinned IS NOT NULL" : "deleted_at IS NULL";
    const column = ORDER_COLUMN[query.order ?? "updated"];
    const items = this.all(
      `SELECT ${SUMMARY_COLUMNS} FROM notes WHERE ${where}
       ORDER BY ${APP_ORDER}, ${column} DESC, id ASC LIMIT ? OFFSET ?`,
      limit,
      offset,
    ).map(toSummary);
    return { items, total: this.count(`SELECT count(*) AS count FROM notes WHERE ${where}`) };
  }

  listTrashed(query: TrashQuery): Page<NoteSummary> {
    const [limit, offset] = bounds(query.limit, query.offset);
    const items = this.all(
      `SELECT ${SUMMARY_COLUMNS} FROM notes WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, id ASC LIMIT ? OFFSET ?`,
      limit,
      offset,
    ).map(toSummary);
    return { items, total: this.count("SELECT count(*) AS count FROM notes WHERE deleted_at IS NOT NULL") };
  }

  search(query: string, options: SearchQuery): Page<SearchHit> {
    const needle = fold(query.trim());
    if (needle === "") return { items: [], total: 0 };
    const [limit] = bounds(options.limit);
    const pattern = substringPattern(needle);
    const state = options.trashed ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
    const where = `${state} AND (title_fold LIKE ?1 ESCAPE '\\' OR text_fold LIKE ?1 ESCAPE '\\' OR (${TITLE_MATCH}))`;
    const rows = this.all(
      `SELECT ${SUMMARY_COLUMNS}, text, (${TITLE_MATCH}) AS title_match FROM notes WHERE ${where}
       ORDER BY title_match DESC, ${APP_ORDER}, updated_at DESC, id ASC LIMIT ?2`,
      pattern,
      limit,
    );
    const items = rows
      .map((row) => ({
        note: toSummary(row),
        titleMatch: fold(displayTitle({ title: String(row.title ?? ""), text: String(row.text ?? "") })).includes(needle),
        snippet: snippetAround(String(row.text ?? ""), needle),
      }))
      // Stable, so the SQL order (app order, then recency) holds within each group.
      .sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch));
    return { items, total: this.count(`SELECT count(*) AS count FROM notes WHERE ${where}`, pattern) };
  }

  get(id: NoteId): Note | null {
    const row = this.one(
      `SELECT id, title, text, markdown, raw_content, pinned, created_at, updated_at, deleted_at,
              last_accessed_at, caret_position
         FROM notes WHERE id = ?`,
      id.toUpperCase(),
    );
    return row ? toNote(row) : null;
  }

  findByIdFragment(fragment: string, limit: number): Page<NoteSummary> {
    const escaped = escapeLike(fragment.toUpperCase());
    const [max] = bounds(limit);
    const where = "id LIKE ?1 ESCAPE '\\' OR id LIKE ?2 ESCAPE '\\'";
    const items = this.all(
      `SELECT ${SUMMARY_COLUMNS} FROM notes WHERE ${where}
        ORDER BY deleted_at IS NOT NULL, updated_at DESC, id ASC LIMIT ?3`,
      `${escaped}%`,
      `%${escaped}`,
      max,
    ).map(toSummary);
    return { items, total: this.count(`SELECT count(*) AS count FROM notes WHERE ${where}`, `${escaped}%`, `%${escaped}`) };
  }

  findByTitle(title: string, limit: number): NoteSummary[] {
    const wanted = fold(title.trim());
    if (wanted === "") return [];
    const [max] = bounds(limit);
    // The LIKE is a prefilter (a display title is part of the title or the text); the exact
    // comparison runs on displayTitle, as the app computes it.
    const rows = this.all(
      `SELECT ${SUMMARY_COLUMNS}, text FROM notes
        WHERE title_fold LIKE ?1 ESCAPE '\\' OR text_fold LIKE ?1 ESCAPE '\\' OR trim(text, ${WS}) = ''
        ORDER BY deleted_at IS NOT NULL, updated_at DESC, id ASC`,
      substringPattern(wanted),
    );
    return rows
      .filter((row) => fold(displayTitle({ title: String(row.title ?? ""), text: String(row.text ?? "") })) === wanted)
      .slice(0, max)
      .map(toSummary);
  }

  currentNoteId(): NoteId | null {
    const row = this.one("SELECT value FROM settings WHERE key = 'currentNoteId'");
    if (!row) return null;
    // The helper stores settings values as JSON (a JSON string for the id). Like its
    // storedCurrentNoteId, a value that is not a JSON string means no current note, so callers
    // fall back to the newest live note just as the app's windowData does.
    let id: unknown;
    try {
      id = JSON.parse(String(row.value ?? ""));
    } catch {
      return null;
    }
    if (typeof id !== "string" || id === "") return null;
    return this.one("SELECT id FROM notes WHERE id = ?", id.toUpperCase()) ? id.toUpperCase() : null;
  }

  backlinks(id: NoteId): NoteSummary[] {
    const target = id.toUpperCase();
    const rows = this.all(
      `SELECT ${SUMMARY_COLUMNS}, markdown FROM notes
        WHERE deleted_at IS NULL AND id <> ?1 AND markdown LIKE ?2 ESCAPE '\\'
        ORDER BY ${APP_ORDER}, updated_at DESC, id ASC`,
      target,
      backlinkLikePattern(target),
    );
    return rows
      .filter((row) => extractNoteLinks(String(row.markdown ?? "")).some((link) => link.id === target))
      .map(toSummary);
  }

  schemaVersion(): number {
    return this.version;
  }

  snapshot<T>(read: (reader: NotesReader) => T): T {
    // Nested snapshots join the outer transaction.
    if (this.depth > 0) return read(this);
    this.exec("BEGIN DEFERRED");
    this.depth = 1;
    let result: T;
    try {
      result = read(this);
    } catch (error) {
      this.depth = 0;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to undo in a read transaction; the original error matters.
      }
      throw error;
    }
    this.depth = 0;
    this.exec("COMMIT");
    return result;
  }

  private exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch {
      throw databaseError();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Closing after a failure is harmless.
    }
  }
}
