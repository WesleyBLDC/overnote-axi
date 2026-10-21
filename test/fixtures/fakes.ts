/**
 * In-memory NotesReader and NotesWriter for command tests (test/commands/), shared by the read
 * and write slices. Both views sit on one FakeStore, so a write is visible to the next read just
 * as it is through the helper and SQLite. Behavior follows overnote docs/architecture.md
 * section 5, and the writer throws the AxiErrors that src/helper/notes-writer.ts translates to:
 *
 * - `get`, `update`, `trash`, `recover`, `duplicate`, `pin`, `unpin`, `movePinned` on a missing
 *   id: NOTE_NOT_FOUND (protocol 404); `permanentlyDelete` on a missing id: NOTE_NOT_FOUND too.
 * - `permanentlyDelete` on a live note: no-op. `pin` on a trashed note: NOTE_TRASHED (409).
 *   `movePinned` on an unpinned note: NOT_PINNED (409); at either end: no-op.
 * - `update` with a stale `expectedUpdatedAt`: `{ status: "conflict", note }`, nothing written.
 *
 * Tests steer edge cases with `failNext(method, error)`, `helperRunning = false`, and
 * `afterUpdate` (for example to simulate the open editor saving over a write).
 */
import { displayTitle, fold } from "@overnote/core/text";

import type {
  HelperProbe,
  ListQuery,
  Note,
  NoteContent,
  NoteCounts,
  NoteId,
  NoteSummary,
  NotesReader,
  NotesWriter,
  Page,
  PinDirection,
  SearchHit,
  SearchQuery,
  SystemStatus,
  TrashQuery,
  UpdateParams,
  UpdateResult,
} from "../../src/domain/types.js";
import { createContext, type Context, type ContextOverrides } from "../../src/context.js";
import { AxiError, axiError } from "../../src/errors.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic 26 char ids: a fixed time part and a counter, sortable like ULIDs. */
export function fakeId(n: number): NoteId {
  let tail = "";
  for (let value = n, i = 0; i < 16; i++, value = Math.floor(value / 32)) tail = CROCKFORD[value % 32] + tail;
  return `01JAB00000${tail}`;
}

export interface FakeNoteInput extends Partial<Omit<Note, "id">> {
  id?: NoteId;
  /** Shortcut: plain markdown, used for markdown, text, and title when those are not given. */
  body?: string;
}

export class FakeStore {
  readonly notes = new Map<NoteId, Note>();
  currentNoteId: NoteId | null = null;
  helperRunning = true;
  clock = 1_792_000_000_000;
  private counter = 0;
  private failures = new Map<string, AxiError>();
  /** Called after every successful content update, with the stored note. */
  afterUpdate?: (note: Note, store: FakeStore) => void;

  now(): number {
    this.clock += 1000;
    return this.clock;
  }

  add(input: FakeNoteInput = {}): Note {
    const body = input.body ?? "";
    const text = input.text ?? body.replace(/^#+\s*/gm, "");
    const at = input.createdAt ?? this.now();
    const note: Note = {
      id: input.id ?? fakeId(++this.counter),
      rawContent: input.rawContent ?? JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
      markdown: input.markdown ?? body,
      text,
      title: input.title ?? (text.split("\n")[0] ?? "").trim(),
      pinned: input.pinned ?? null,
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
      deletedAt: input.deletedAt ?? null,
      lastAccessedAt: input.lastAccessedAt ?? at,
      caretPosition: input.caretPosition ?? null,
    };
    this.notes.set(note.id, note);
    return note;
  }

  /** The next call of `method` on the writer throws `error` instead of running. */
  failNext(method: keyof NotesWriter, error: AxiError): void {
    this.failures.set(method, error);
  }

  takeFailure(method: string): void {
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  live(): Note[] {
    return [...this.notes.values()].filter((note) => note.deletedAt === null);
  }
}

export function summary(note: Note): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    preview: note.text.slice(0, 200),
    charCount: Array.from(note.text).length,
    pinned: note.pinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    lastAccessedAt: note.lastAccessedAt,
  };
}

function appOrder(order: ListQuery["order"] = "updated") {
  const key = (note: Note) =>
    order === "accessed" ? (note.lastAccessedAt ?? 0) : order === "created" ? note.createdAt : note.updatedAt;
  return (a: Note, b: Note) => {
    if (a.pinned !== null || b.pinned !== null) {
      if (a.pinned === null) return 1;
      if (b.pinned === null) return -1;
      if (a.pinned !== b.pinned) return a.pinned - b.pinned;
    }
    return key(b) - key(a) || a.id.localeCompare(b.id);
  };
}

function page<T>(items: T[], limit: number, offset = 0): Page<T> {
  return { items: items.slice(offset, offset + limit), total: items.length };
}

function notFound(): AxiError {
  return axiError("No note matches that id", "NOTE_NOT_FOUND");
}

export class FakeReader implements NotesReader {
  closed = false;
  schema = 1;

  constructor(readonly store: FakeStore) {}

  counts(): NoteCounts {
    const all = [...this.store.notes.values()];
    const live = all.filter((note) => note.deletedAt === null);
    return { live: live.length, pinned: live.filter((note) => note.pinned !== null).length, trashed: all.length - live.length };
  }

  list(query: ListQuery): Page<NoteSummary> {
    const notes = this.store
      .live()
      .filter((note) => !query.pinnedOnly || note.pinned !== null)
      .sort(appOrder(query.order));
    return page(notes.map(summary), query.limit, query.offset);
  }

  listTrashed(query: TrashQuery): Page<NoteSummary> {
    const notes = [...this.store.notes.values()]
      .filter((note) => note.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0) || a.id.localeCompare(b.id));
    return page(notes.map(summary), query.limit, query.offset);
  }

  search(query: string, options: SearchQuery): Page<SearchHit> {
    const needle = fold(query);
    const pool = [...this.store.notes.values()].filter((note) => (note.deletedAt !== null) === (options.trashed ?? false));
    const hits: SearchHit[] = [];
    for (const note of pool.sort(appOrder())) {
      const titleMatch = fold(displayTitle(note)).includes(needle);
      const at = fold(note.text).indexOf(needle);
      if (!titleMatch && at === -1) continue;
      const start = Math.max(0, at - 30);
      const snippet = at === -1 ? "" : note.text.slice(start, start + 80).replace(/\s+/g, " ").trim();
      hits.push({ note: summary(note), titleMatch, snippet });
    }
    hits.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch));
    return page(hits, options.limit);
  }

  get(id: NoteId): Note | null {
    const note = this.store.notes.get(id.toUpperCase());
    return note ? { ...note } : null;
  }

  findByIdFragment(fragment: string, limit: number): NoteSummary[] {
    const upper = fragment.toUpperCase();
    return [...this.store.notes.values()]
      .filter((note) => note.id.startsWith(upper) || note.id.endsWith(upper))
      .slice(0, limit)
      .map(summary);
  }

  findByTitle(title: string, limit: number): NoteSummary[] {
    const wanted = fold(title);
    return [...this.store.notes.values()]
      .filter((note) => fold(displayTitle(note)) === wanted)
      .sort((a, b) => Number(a.deletedAt !== null) - Number(b.deletedAt !== null))
      .slice(0, limit)
      .map(summary);
  }

  currentNoteId(): NoteId | null {
    const id = this.store.currentNoteId;
    return id && this.store.notes.has(id) ? id : null;
  }

  backlinks(id: NoteId): NoteSummary[] {
    const pattern = new RegExp(`toggle-notes\\?context=[^)\\s]*${id}`);
    return this.store
      .live()
      .filter((note) => note.id !== id && pattern.test(decodeURIComponent(note.markdown)))
      .sort(appOrder())
      .map(summary);
  }

  schemaVersion(): number {
    return this.schema;
  }

  snapshot<T>(read: (reader: NotesReader) => T): T {
    return read(this);
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeWriter implements NotesWriter {
  closed = false;
  /** Every method call in order, for assertions such as "nothing was written". */
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(readonly store: FakeStore) {}

  private enter(method: keyof NotesWriter, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (!this.store.helperRunning) {
      throw axiError("Overnote is not running", "HELPER_NOT_RUNNING", ["overnote-axi open"]);
    }
    this.store.takeFailure(method);
  }

  private find(id: NoteId): Note {
    const note = this.store.notes.get(id);
    if (!note) throw notFound();
    return note;
  }

  async ping(): Promise<{ version: string; pid: number }> {
    this.enter("ping");
    return { version: "0.3.0", pid: 4242 };
  }

  async status(): Promise<SystemStatus> {
    this.enter("status");
    return {
      version: "0.3.0",
      pid: 4242,
      schemaVersion: 1,
      noteCount: this.store.live().length,
      backupDir: "/tmp/overnote-axi-fake/backups",
      backupCount: 0,
      latestBackup: null,
      restoreAvailable: false,
    };
  }

  async create(content: NoteContent, options?: { show?: boolean }): Promise<Note> {
    this.enter("create", content, options);
    const note = this.store.add({ ...content });
    this.store.currentNoteId = note.id;
    return { ...note };
  }

  async get(id: NoteId): Promise<Note> {
    this.enter("get", id);
    return { ...this.find(id) };
  }

  async update(params: UpdateParams): Promise<UpdateResult> {
    this.enter("update", params);
    const note = this.find(params.id);
    if (params.expectedUpdatedAt !== undefined && params.expectedUpdatedAt !== note.updatedAt) {
      return { status: "conflict", note: { ...note } };
    }
    const { id: _id, expectedUpdatedAt: _expected, caretPosition, ...content } = params;
    Object.assign(note, content);
    if (caretPosition !== undefined) note.caretPosition = caretPosition;
    if (Object.keys(content).length > 0) note.updatedAt = Math.max(this.store.now(), note.updatedAt + 1);
    this.store.afterUpdate?.(note, this.store);
    return { status: "ok", note: { ...note } };
  }

  async trash(id: NoteId): Promise<void> {
    this.enter("trash", id);
    const note = this.find(id);
    note.deletedAt = this.store.now();
    note.pinned = null;
    note.updatedAt += 1;
  }

  async recover(id: NoteId): Promise<Note> {
    this.enter("recover", id);
    const note = this.find(id);
    note.deletedAt = null;
    note.updatedAt += 1;
    return { ...note };
  }

  async permanentlyDelete(id: NoteId): Promise<void> {
    this.enter("permanentlyDelete", id);
    const note = this.find(id);
    if (note.deletedAt !== null) this.store.notes.delete(id);
  }

  async emptyTrash(): Promise<number> {
    this.enter("emptyTrash");
    let count = 0;
    for (const note of [...this.store.notes.values()]) {
      if (note.deletedAt !== null) {
        this.store.notes.delete(note.id);
        count++;
      }
    }
    return count;
  }

  async duplicate(id: NoteId, titleSuffix?: string): Promise<Note> {
    this.enter("duplicate", id, titleSuffix);
    const source = this.find(id);
    const copy = this.store.add({
      rawContent: source.rawContent,
      markdown: source.markdown,
      text: source.text,
      title: titleSuffix ? `${source.title} ${titleSuffix}` : source.title,
      caretPosition: 0,
    });
    this.store.currentNoteId = copy.id;
    return { ...copy };
  }

  async pin(id: NoteId): Promise<Note> {
    this.enter("pin", id);
    const note = this.find(id);
    if (note.deletedAt !== null) throw axiError("Trashed notes cannot be pinned", "NOTE_TRASHED");
    if (note.pinned === null) {
      const keys = this.store.live().flatMap((other) => (other.pinned === null ? [] : [other.pinned]));
      note.pinned = (keys.length > 0 ? Math.max(...keys) : 0) + 1000;
    }
    return { ...note };
  }

  async unpin(id: NoteId): Promise<Note> {
    this.enter("unpin", id);
    const note = this.find(id);
    note.pinned = null;
    return { ...note };
  }

  async movePinned(id: NoteId, direction: PinDirection): Promise<void> {
    this.enter("movePinned", id, direction);
    const note = this.find(id);
    if (note.pinned === null || note.deletedAt !== null) throw axiError("The note is not pinned", "NOT_PINNED");
    const pins = this.store
      .live()
      .filter((other) => other.pinned !== null)
      .sort((a, b) => (a.pinned ?? 0) - (b.pinned ?? 0));
    const index = pins.findIndex((other) => other.id === id);
    const neighbor = pins[direction === "up" ? index - 1 : index + 1];
    if (!neighbor) return;
    [note.pinned, neighbor.pinned] = [neighbor.pinned, note.pinned];
  }

  close(): void {
    this.closed = true;
  }
}

export interface Fakes {
  store: FakeStore;
  reader: FakeReader;
  writer: FakeWriter;
  probe: () => Promise<HelperProbe>;
}

/** One store with a reader, a writer, and a helper probe that follows `store.helperRunning`. */
export function createFakes(): Fakes {
  const store = new FakeStore();
  const reader = new FakeReader(store);
  const writer = new FakeWriter(store);
  const probe = async (): Promise<HelperProbe> =>
    store.helperRunning ? { state: "running", version: "0.3.0", pid: 4242 } : { state: "stopped" };
  return { store, reader, writer, probe };
}

export interface FakeContext {
  context: Context;
  fakes: Fakes;
  /** URLs passed to openUrl, in order (nothing is ever really opened). */
  opened: string[];
  /** Milliseconds passed to sleep, in order (sleep resolves at once). */
  slept: number[];
}

/**
 * A Context over the fakes with the real @overnote/core converter, an instant sleep, and a
 * recording URL opener. `home` defaults to the isolated HOME that test/setup.ts installs.
 */
export function fakeContext(overrides: ContextOverrides = {}, fakes: Fakes = createFakes()): FakeContext {
  const opened: string[] = [];
  const slept: number[] = [];
  const context = createContext({
    env: process.env,
    home: process.env.HOME,
    uid: 501,
    binPath: "/opt/overnote-axi/dist/overnote-axi.js",
    now: () => fakes.store.clock,
    paths: () => ({
      supportDir: "/tmp/overnote-axi-fake/support",
      database: "/tmp/overnote-axi-fake/support/notes.sqlite",
      runtimeDir: "/tmp/overnote-axi-fake/run",
      socket: "/tmp/overnote-axi-fake/run/helper.sock",
    }),
    openReader: () => fakes.reader,
    connectWriter: async () => {
      if (!fakes.store.helperRunning) {
        throw axiError("Overnote is not running", "HELPER_NOT_RUNNING", ["overnote-axi open"]);
      }
      return fakes.writer;
    },
    probeHelper: fakes.probe,
    loadConverter: async () => (await import("../../src/markdown/convert.js")).converter,
    readStdin: async () => null,
    openUrl: async (url) => {
      opened.push(url);
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...overrides,
  });
  return { context, fakes, opened, slept };
}
