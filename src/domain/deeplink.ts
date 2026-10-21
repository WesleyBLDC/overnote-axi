/**
 * Overnote deeplinks (slice: foundation). Mirrors overnote src/domain/deeplink.ts:
 * `raycast://extensions/wesleybldc/overnote/toggle-notes?context=<urlencoded {"id":"..."}>`
 * opens a note; `.../open-notes` opens the panel on the last note.
 */
import type { NoteId, NoteLink } from "./types.js";
import { notImplemented } from "../errors.js";

export const EXTENSION_OWNER = "wesleybldc";
export const EXTENSION_NAME = "overnote";

export function noteDeeplink(_id: NoteId): string {
  throw notImplemented("noteDeeplink");
}

export function openNotesDeeplink(): string {
  throw notImplemented("openNotesDeeplink");
}

/** `[<title>](<deeplink>)`, with the title escaped for markdown link text. */
export function markdownNoteLink(_title: string, _id: NoteId): string {
  throw notImplemented("markdownNoteLink");
}

/**
 * Every Overnote note deeplink in the markdown, in order, without duplicates. The context is
 * decoded (percent encoded or a hand pasted raw `{"id":...}`) before the id is read.
 */
export function extractNoteLinks(_markdown: string): NoteLink[] {
  throw notImplemented("extractNoteLinks");
}

/**
 * A LIKE prefilter for markdown that may link to `id`: `%toggle-notes?context=%<id>%` with `%`,
 * `_` and the escape character escaped (use with `ESCAPE '\\'`). It is a full table scan and can
 * over match; NotesReader.backlinks confirms each candidate with extractNoteLinks.
 */
export function backlinkLikePattern(_id: NoteId): string {
  throw notImplemented("backlinkLikePattern");
}
