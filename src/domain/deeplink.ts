/**
 * Overnote deeplinks. Mirrors overnote src/domain/deeplink.ts:
 * `raycast://extensions/wesleybldc/overnote/toggle-notes?context=<urlencoded {"id":"..."}>`
 * opens a note; `.../open-notes` opens the panel on the last note.
 */
import type { NoteId, NoteLink } from "./types.js";

export const EXTENSION_OWNER = "wesleybldc";
export const EXTENSION_NAME = "overnote";

const EXTENSION_BASE = `raycast://extensions/${EXTENSION_OWNER}/${EXTENSION_NAME}`;
const TOGGLE_PREFIX = `${EXTENSION_BASE}/toggle-notes?context=`;

/** Crockford base32 ULID: 26 chars, no I, L, O or U. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * An optional markdown link text (`[label](`) followed by a note deeplink. The context is either
 * a raw JSON object (a hand pasted `{"id":...}`, which may contain spaces) or a URL component,
 * which ends at whitespace or the characters that close a markdown link or autolink.
 */
const LINK_PATTERN =
  /(?:\[((?:\\.|[^\]\\])*)\]\(<?)?raycast:\/\/extensions\/wesleybldc\/overnote\/toggle-notes\?context=(\{[^}]*\}|[^\s)>\]"']*)/gi;

export function noteDeeplink(id: NoteId): string {
  return `${TOGGLE_PREFIX}${encodeURIComponent(JSON.stringify({ id }))}`;
}

export function openNotesDeeplink(): string {
  return `${EXTENSION_BASE}/open-notes`;
}

/** Escapes text for use inside markdown link brackets. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/** `[<title>](<deeplink>)`, with the title escaped for markdown link text. */
export function markdownNoteLink(title: string, id: NoteId): string {
  return `[${escapeLinkText(title)}](${noteDeeplink(id)})`;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The note id inside a deeplink context, or null when it is not a valid `{ "id": "<ULID>" }`. */
export function contextNoteId(context: string): NoteId | null {
  // Only the context parameter itself: later query parameters (`&launchType=...`) are not part of it.
  const raw = context.startsWith("{") ? context : (context.split("&")[0] ?? "");
  // Decode until stable, so a doubly encoded context (a link pasted through another URL) still resolves.
  let text = raw;
  for (let i = 0; i < 3; i++) {
    const next = decode(text);
    if (next === text) break;
    text = next;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && ULID.test(id) ? id.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Every Overnote note deeplink in the markdown, in order, without duplicates. The context is
 * decoded (percent encoded or a hand pasted raw `{"id":...}`) before the id is read.
 */
export function extractNoteLinks(markdown: string): NoteLink[] {
  const seen = new Set<NoteId>();
  const links: NoteLink[] = [];
  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const id = contextNoteId(match[2] ?? "");
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    links.push({ id, label: (match[1] ?? "").replace(/\\(.)/g, "$1") });
  }
  return links;
}

/** Escapes `%`, `_` and `\` for a LIKE pattern used with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * A LIKE prefilter for markdown that may link to `id`: `%toggle-notes?context=%<id>%` with `%`,
 * `_` and the escape character escaped (use with `ESCAPE '\\'`). It is a full table scan and can
 * over match; NotesReader.backlinks confirms each candidate with extractNoteLinks.
 */
export function backlinkLikePattern(id: NoteId): string {
  return `%${escapeLike("toggle-notes?context=")}%${escapeLike(id)}%`;
}
