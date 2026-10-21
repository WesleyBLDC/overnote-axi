/**
 * `<note>` reference parsing and resolution. See docs/DESIGN.md
 * "Note references".
 *
 * Accepted forms, tried in this order:
 * 1. `current`: the note Overnote last showed.
 * 2. A full 26 char ULID (case-insensitive).
 * 3. `title:<text>`: the display title equals <text> after folding.
 * 4. A unique id prefix or suffix of at least 6 characters (suffixes are what to recommend:
 *    ULID prefixes are creation timestamps that nearby notes share).
 *
 * Resolution failures are AxiErrors: NOTE_NOT_FOUND, AMBIGUOUS_NOTE (the total, up to 5
 * candidate rows in `details`, and a hint that repeats the command with `<id>`), and
 * NOTE_TRASHED when `allowTrashed` is false. Messages quote references in single quotes, which
 * TOON prints unescaped; hints quote them for the shell.
 */
import { displayTitle } from "@overnote/core/text";

import { shellQuote } from "../args.js";
import type { Note, NoteRef, NoteSummary, NotesReader, Page, ResolveOptions } from "../domain/types.js";
import { axiError, validation, type AxiError } from "../errors.js";

export const MIN_FRAGMENT_LENGTH = 6;
/** Candidate rows an AMBIGUOUS_NOTE error lists. */
export const MAX_CANDIDATES = 5;
/** How many title matches are counted for the AMBIGUOUS_NOTE total. */
const MAX_COUNTED = 1000;

/** Why an id suffix beats a prefix: shown only with AMBIGUOUS_NOTE for a fragment and a too short fragment. */
export const SUFFIX_ADVICE = "ULID prefixes are creation timestamps that nearby notes share; pass the last 6 or more characters of the id";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const ID_CHARS = /^[0-9A-HJKMNP-TV-Z]+$/i;
const TITLE_PREFIX = "title:";

/** A reference inside a message: single quotes, which TOON prints without escaping. */
function quoted(text: string): string {
  return `'${text}'`;
}

/** Where a failing lookup sends the caller next: the command's own scope. */
interface Scope {
  command: string;
  /** `recover` looks in Recently Deleted. */
  trash: boolean;
}

function scopeOf(options?: Pick<ResolveOptions, "command">): Scope {
  const command = options?.command ?? "read";
  return { command, trash: command === "recover" };
}

function searchHint(text: string, scope: Scope): string {
  return `overnote-axi search ${shellQuote(text)}${scope.trash ? " --trash" : ""}`;
}

function listHint(scope: Scope): string {
  return scope.trash ? "overnote-axi trash" : "overnote-axi list";
}

export function parseRef(raw: string, options?: Pick<ResolveOptions, "command">): NoteRef {
  const scope = scopeOf(options);
  const value = raw.trim();
  if (value === "") {
    throw validation("a note reference is required", [listHint(scope), "overnote-axi read current"]);
  }
  if (value.toLowerCase() === "current") return { kind: "current" };
  if (ULID.test(value)) return { kind: "id", id: value.toUpperCase() };
  if (value.slice(0, TITLE_PREFIX.length).toLowerCase() === TITLE_PREFIX) {
    const title = value.slice(TITLE_PREFIX.length).trim();
    if (title === "") throw validation("title: needs the note's title after it", ["overnote-axi read title:<exact title>"]);
    return { kind: "title", title };
  }
  if (value.length >= MIN_FRAGMENT_LENGTH && value.length < 26 && ID_CHARS.test(value)) {
    return { kind: "fragment", fragment: value.toUpperCase() };
  }
  if (ID_CHARS.test(value) && value.length < MIN_FRAGMENT_LENGTH) {
    throw validation(`an id fragment needs at least ${MIN_FRAGMENT_LENGTH} characters (got ${quoted(value)}); ${SUFFIX_ADVICE}`, [
      listHint(scope),
    ]);
  }
  throw validation(`${quoted(value)} is not a note reference`, [
    searchHint(value, scope),
    `overnote-axi ${scope.command} ${shellQuote(`title:${value}`)}`,
  ]);
}

function notFound(message: string, hints: readonly string[]): AxiError {
  return axiError(message, "NOTE_NOT_FOUND", hints);
}

function ambiguous(raw: string, page: Page<NoteSummary>, ref: NoteRef, scope: Scope): AxiError {
  const shown = page.items.slice(0, MAX_CANDIDATES);
  const total = page.total > MAX_COUNTED ? `more than ${MAX_COUNTED}` : String(page.total);
  const showing = page.total > shown.length ? `; showing ${shown.length}` : "";
  const advice = ref.kind === "fragment" ? `; ${SUFFIX_ADVICE}` : "";
  return axiError(`${quoted(raw)} matches ${total} notes${showing}${advice}`, "AMBIGUOUS_NOTE", [`overnote-axi ${scope.command} <id>`], {
    candidates: shown.map((note) => ({
      id: note.id,
      title: displayTitle({ title: note.title, text: note.preview }),
      state: note.deletedAt === null ? "live" : "trashed",
    })),
  });
}

/** The most recently updated live note (the app's fallback for `current`), or null. */
function mostRecentLive(reader: NotesReader): Note | null {
  // Pinned notes sort first in list(), so one page of pinned + 1 always holds the newest note.
  const { pinned } = reader.counts();
  const page = reader.list({ limit: pinned + 1 });
  let best: NoteSummary | undefined;
  for (const note of page.items) {
    if (!best || note.updatedAt > best.updatedAt || (note.updatedAt === best.updatedAt && note.id < best.id)) best = note;
  }
  return best ? reader.get(best.id) : null;
}

function resolveCurrent(reader: NotesReader): Note {
  const id = reader.currentNoteId();
  const shown = id ? reader.get(id) : null;
  // As in the app (notes.windowData): a missing or trashed current note falls back to the newest live note.
  const note = shown && shown.deletedAt === null ? shown : mostRecentLive(reader);
  if (!note) {
    throw axiError("there are no live notes yet", "NOTE_NOT_FOUND", ['overnote-axi create --content "<markdown>"']);
  }
  return note;
}

function find(reader: NotesReader, raw: string, ref: NoteRef, scope: Scope): Note {
  const idHints = [listHint(scope)];
  switch (ref.kind) {
    case "current":
      return resolveCurrent(reader);
    case "id": {
      const note = reader.get(ref.id);
      if (!note) throw notFound(`no note has id ${ref.id}`, idHints);
      return note;
    }
    case "title": {
      const matches = reader.findByTitle(ref.title, MAX_COUNTED + 1);
      const live = matches.filter((note) => note.deletedAt === null);
      // Live notes win over trashed ones with the same title.
      const pool = live.length > 0 ? live : matches;
      return pick(reader, raw, ref, { items: pool, total: pool.length }, [searchHint(ref.title, scope), listHint(scope)], scope);
    }
    case "fragment": {
      const page = reader.findByIdFragment(ref.fragment, MAX_CANDIDATES);
      return pick(reader, raw, ref, page, idHints, scope);
    }
  }
}

function pick(
  reader: NotesReader,
  raw: string,
  ref: NoteRef,
  page: Page<NoteSummary>,
  hints: readonly string[],
  scope: Scope,
): Note {
  const [only] = page.items;
  if (!only) throw notFound(`no note matches ${quoted(raw)}`, hints);
  if (page.total > 1) throw ambiguous(raw, page, ref, scope);
  const note = reader.get(only.id);
  if (!note) throw notFound(`no note matches ${quoted(raw)}`, hints);
  return note;
}

/** The one NOTE_TRASHED error every command throws for a note in Recently Deleted. */
export function trashedError(note: Pick<Note, "id" | "title" | "text">): AxiError {
  return axiError(`note ${quoted(displayTitle(note))} is in Recently Deleted`, "NOTE_TRASHED", [`overnote-axi recover ${note.id}`], {
    id: note.id,
  });
}

export function resolveNote(reader: NotesReader, raw: string, options: ResolveOptions): Note {
  const scope = scopeOf(options);
  const note = find(reader, raw.trim(), parseRef(raw, options), scope);
  if (!options.allowTrashed && note.deletedAt !== null) throw trashedError(note);
  return note;
}
