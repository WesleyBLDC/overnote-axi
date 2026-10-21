/**
 * Shared domain types and the three ports every command talks through.
 *
 * Overnote's own data and RPC types come from @overnote/core's light `text` entry (type-only
 * imports, nothing loads at runtime), so this CLI and the app share one definition
 * (overnote docs/architecture.md sections 4 and 5).
 */
import type { rpc } from "@overnote/core/text";

import type { Millis, Note, NoteContent, NoteId, NoteSummary } from "@overnote/core/text";

export type { Millis, Note, NoteContent, NoteId, NoteSummary };

export type SystemStatus = rpc.SystemStatus;
export type UpdateParams = rpc.UpdateParams;
export type UpdateResult = rpc.UpdateResult;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Where a note lives: the normal list or Recently Deleted. */
export type NoteState = "live" | "trashed";

/** Pre-computed aggregates for the home view and list counts. */
export interface NoteCounts {
  live: number;
  pinned: number;
  trashed: number;
}

export type ListOrder = "updated" | "accessed" | "created";

export interface ListQuery {
  limit: number;
  offset?: number;
  /** Only pinned notes, in pin order. */
  pinnedOnly?: boolean;
  /** Ordering after pinned notes; pinned notes always come first in pin order. Default `updated`. */
  order?: ListOrder;
}

export interface TrashQuery {
  limit: number;
  offset?: number;
}

export interface SearchQuery {
  limit: number;
  /** Search Recently Deleted instead of live notes. */
  trashed?: boolean;
}

/** A page of results plus the total before the limit (AXI principle 4). */
export interface Page<T> {
  items: T[];
  total: number;
}

export interface SearchHit {
  note: NoteSummary;
  /** The folded query occurs in the display title. Title hits sort first. */
  titleMatch: boolean;
  /** About 80 chars of plain text around the first match, on one line. */
  snippet: string;
}

/** An Overnote deeplink found in a note's markdown. */
export interface NoteLink {
  id: NoteId;
  /** The markdown link text, or the empty string for a bare URL. */
  label: string;
}

export type PinDirection = "up" | "down";

/** Every location the CLI reads or connects to (see src/config/paths.ts). */
export interface OvernotePaths {
  /** The extension's support dir, `OVERNOTE_SUPPORT_DIR` overrides it. */
  supportDir: string;
  /** `<supportDir>/notes.sqlite`. */
  database: string;
  /** `/tmp/overnote-<uid>`, `OVERNOTE_RUNTIME_DIR` overrides it. */
  runtimeDir: string;
  /** `<runtimeDir>/helper.sock`. */
  socket: string;
}

// ---------------------------------------------------------------------------
// Ports. Commands depend on these interfaces only; src/context.ts wires the implementations.
// ---------------------------------------------------------------------------

/**
 * Read-only access to the notes database (src/store/readonly-db.ts). Synchronous, works while
 * Overnote is closed, and never writes. Ordering and matching mirror the helper exactly.
 */
export interface NotesReader {
  counts(): NoteCounts;
  /** Live notes: pinned first in pin order, then by `order` desc, then id asc. */
  list(query: ListQuery): Page<NoteSummary>;
  /** Recently Deleted, most recently deleted first. */
  listTrashed(query: TrashQuery): Page<NoteSummary>;
  /** Folded substring match on title or text (the app's fold rule); title hits first. */
  search(query: string, options: SearchQuery): Page<SearchHit>;
  /** Any note by full id, live or trashed. */
  get(id: NoteId): Note | null;
  /** Notes whose id starts or ends with the fragment (case-insensitive), live or trashed. */
  findByIdFragment(fragment: string, limit: number): NoteSummary[];
  /** Notes whose display title equals the given text after folding, live first. */
  findByTitle(title: string, limit: number): NoteSummary[];
  /** The note Overnote last showed (settings key `currentNoteId`), if it still exists. */
  currentNoteId(): NoteId | null;
  /** Live notes whose markdown links to `id`. */
  backlinks(id: NoteId): NoteSummary[];
  /** `PRAGMA user_version` of the database. */
  schemaVersion(): number;
  close(): void;
}

/**
 * Every write, through the running Overnote helper (src/helper/notes-writer.ts). Overnote stays
 * the single writer and the open editor reloads live. Methods map 1:1 to `notes.*` RPCs and
 * translate helper errors into AxiErrors.
 */
export interface NotesWriter {
  ping(): Promise<{ version: string; pid: number }>;
  status(): Promise<SystemStatus>;
  create(content: NoteContent, options?: { show?: boolean }): Promise<Note>;
  get(id: NoteId): Promise<Note>;
  /** Returns the conflict result instead of throwing, so callers can report STALE_WRITE. */
  update(params: UpdateParams): Promise<UpdateResult>;
  /** Soft delete into Recently Deleted. */
  trash(id: NoteId): Promise<void>;
  recover(id: NoteId): Promise<Note>;
  /** Only affects notes already in the trash. */
  permanentlyDelete(id: NoteId): Promise<void>;
  emptyTrash(): Promise<number>;
  duplicate(id: NoteId, titleSuffix?: string): Promise<Note>;
  pin(id: NoteId): Promise<Note>;
  unpin(id: NoteId): Promise<Note>;
  movePinned(id: NoteId, direction: PinDirection): Promise<void>;
  close(): void;
}

/** Markdown to stored content exactly as the editor does it (src/markdown/convert.ts). */
export interface MarkdownConverter {
  fromMarkdown(markdown: string): NoteContent;
}

/** A parsed `<note>` argument (see src/store/refs.ts and docs/DESIGN.md "Note references"). */
export type NoteRef =
  | { kind: "id"; id: NoteId }
  | { kind: "fragment"; fragment: string }
  | { kind: "current" }
  | { kind: "title"; title: string };

/** When a command touches a note, which states it accepts. */
export interface ResolveOptions {
  /** Default false: a trashed match is NOTE_TRASHED for content writes and still resolves for reads. */
  allowTrashed: boolean;
}

