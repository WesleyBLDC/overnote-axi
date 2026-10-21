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

/** What a short ping of the helper found (home view, status, session hook). */
export type HelperProbe =
  | { state: "running"; version: string; pid: number }
  /** No socket, refused, or an untrusted runtime dir. */
  | { state: "stopped" }
  /** The socket accepted the connection but did not answer within the probe timeout. */
  | { state: "not-answering" };

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
  /**
   * Notes whose id starts or ends with the fragment (case-insensitive), live or trashed: up to
   * `limit` rows, live first, and the total number of matches.
   */
  findByIdFragment(fragment: string, limit: number): Page<NoteSummary>;
  /** Notes whose display title equals the given text after folding, live first. */
  findByTitle(title: string, limit: number): NoteSummary[];
  /** The note Overnote last showed (settings key `currentNoteId`), if it still exists. */
  currentNoteId(): NoteId | null;
  /** Live notes whose markdown links to `id`. */
  backlinks(id: NoteId): NoteSummary[];
  /** `PRAGMA user_version` of the database (checked against SUPPORTED_SCHEMA_VERSIONS on open). */
  schemaVersion(): number;
  /**
   * Runs `read` inside one deferred read transaction (BEGIN ... COMMIT, allowed under
   * query_only), so every query of one command sees the same WAL snapshot and counts never
   * disagree with rows. Commands wrap all of their reads in one call.
   */
  snapshot<T>(read: (reader: NotesReader) => T): T;
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
  /**
   * An exact copy (`notes.duplicate { id }`). A title suffix is written afterwards with `update`,
   * because helpers before protocol v3.0 store `titleSuffix` in the title only and v3.0 refuses it.
   */
  duplicate(id: NoteId): Promise<Note>;
  pin(id: NoteId): Promise<Note>;
  unpin(id: NoteId): Promise<Note>;
  movePinned(id: NoteId, direction: PinDirection): Promise<void>;
  /** Persists the current note id (settings key `currentNoteId`), as the panel does on a switch. */
  setCurrentNote(id: NoteId): Promise<void>;
  close(): void;
}

/**
 * Where `update` and `link --into` add blocks: after the last block (`append`), after the title
 * line when the note starts with one, else on top (`prepend`), or above everything (`top`).
 */
export type ComposeMode = "append" | "prepend" | "top";

/** The stored fields a conversion needs from an existing note. */
export type StoredNote = Pick<Note, "rawContent" | "text">;

/**
 * What a markdown rewrite of a note would lose (see src/markdown/convert.ts):
 * - `unsupported-content`: nodes or marks the editor preserves but markdown cannot express;
 * - `collapsed-toggle`: a collapsed toggle list, which markdown always reopens;
 * - `formatting`: anything else where the markdown round trip changes the stored document.
 */
export type RewriteLoss = "collapsed-toggle" | "formatting" | "unsupported-content";

/**
 * Stored content exactly as the editor produces it (src/markdown/convert.ts, the only full
 * @overnote/core importer). Existing notes are never rebuilt from their markdown unless
 * `rewriteLosses` returned an empty list, because markdown is lossy relative to rawContent.
 */
export interface MarkdownConverter {
  /** A brand new note (create) or a full rewrite that rewriteLosses allowed. */
  fromMarkdown(markdown: string): NoteContent;
  /** The markdown core would store for this text (for no-op checks against stored markdown). */
  normalize(markdown: string): string;
  /**
   * Joins the addition's blocks to the stored document's blocks: after them (append), after the
   * title line when the first block is one, else before them (prepend), or before them (top).
   */
  compose(note: StoredNote, addition: string, mode: ComposeMode): NoteContent;
  /**
   * The markdown below the title line when the note's first block is one (where `prepend`
   * inserts, for its no-op check); null when the note has no such title block.
   */
  belowTitle(note: StoredNote): string | null;
  /** Every field derived from the stored document, as a write of it unchanged would store them. */
  current(note: StoredNote): NoteContent;
  /** Empty when a markdown rewrite keeps the stored document exactly; else what would be lost. */
  rewriteLosses(note: StoredNote): RewriteLoss[];
  /**
   * The content of a copy whose title ends in `suffix`: the suffix goes into the line the title
   * comes from and every field is derived from the result (core's `duplicateContent` rule).
   */
  duplicateContent(note: StoredNote, suffix: string): NoteContent;
  /**
   * Exact text replacement against the markdown `read` shows, scoped to the top level blocks
   * that contain the match (whole document only when the match spans blocks). The caller
   * refuses with LOSSY_REWRITE when `losses` is not empty, unless `--allow-loss` was given.
   */
  edit(note: StoredNote, oldText: string, newText: string, all: boolean): EditOutcome;
  /**
   * Whether a write still stands in `after`, a later stored version: every top level block the
   * write added (in `written`, not in `before`) is still there, and every block it removed is
   * still gone. True when the open editor merged its own edits around the write; false when an
   * editor that does not merge saved its older content over it (OVERWRITTEN_BY_EDITOR).
   */
  writeSurvived(before: StoredNote, written: StoredNote, after: StoredNote): boolean;
}

export type EditOutcome =
  | {
      status: "ok";
      content: NoteContent;
      replaced: number;
      /** `blocks`: only the matching blocks were rewritten; `document`: the whole note was. */
      scope: "blocks" | "document";
      /** What rewriting the touched blocks (or the document) through markdown loses. */
      losses: RewriteLoss[];
    }
  | { status: "not-found" }
  | { status: "ambiguous"; matches: number };

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
  /**
   * The command doing the lookup (default `read`), so error hints repeat it (`delete <id>`) and
   * look where that command looks (`trash` for `recover`).
   */
  command?: string;
}

