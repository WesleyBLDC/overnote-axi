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

/** Every Overnote note deeplink in the markdown, in order, without duplicates. */
export function extractNoteLinks(_markdown: string): NoteLink[] {
  throw notImplemented("extractNoteLinks");
}

/** A LIKE pattern matching markdown that links to `id` (used by NotesReader.backlinks). */
export function backlinkLikePattern(_id: NoteId): string {
  throw notImplemented("backlinkLikePattern");
}
