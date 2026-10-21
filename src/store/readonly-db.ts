/**
 * Read-only access to Overnote's database with node:sqlite (slice: foundation).
 *
 * Port of overnote src/domain/readonly-db.ts: opened with `readOnly: true`, `PRAGMA query_only`,
 * and a short busy timeout, every query parameterized. Ordering and matching mirror the helper
 * (architecture.md section 5): pinned key asc first, then the order column desc, then id asc;
 * filters fold with @overnote/core/text `fold` and match `title_fold` / `text_fold` with an
 * escaped LIKE. Loading node:sqlite mutes only its ExperimentalWarning.
 */
import type {
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
import { notImplemented } from "../errors.js";

/**
 * Opens the database, or returns null when the file does not exist yet.
 * Throws DATABASE_ERROR (never a raw SQLite message) when it exists but cannot be read.
 */
export function openReader(_file: string): NotesReader | null {
  throw notImplemented("openReader");
}

/** The class behind openReader, exported for tests. */
export class ReadOnlyNotesDb implements NotesReader {
  counts(): NoteCounts {
    throw notImplemented("counts");
  }
  list(_query: ListQuery): Page<NoteSummary> {
    throw notImplemented("list");
  }
  listTrashed(_query: TrashQuery): Page<NoteSummary> {
    throw notImplemented("listTrashed");
  }
  search(_query: string, _options: SearchQuery): Page<SearchHit> {
    throw notImplemented("search");
  }
  get(_id: NoteId): Note | null {
    throw notImplemented("get");
  }
  findByIdFragment(_fragment: string, _limit: number): NoteSummary[] {
    throw notImplemented("findByIdFragment");
  }
  findByTitle(_title: string, _limit: number): NoteSummary[] {
    throw notImplemented("findByTitle");
  }
  currentNoteId(): NoteId | null {
    throw notImplemented("currentNoteId");
  }
  backlinks(_id: NoteId): NoteSummary[] {
    throw notImplemented("backlinks");
  }
  schemaVersion(): number {
    throw notImplemented("schemaVersion");
  }
  close(): void {}
}
