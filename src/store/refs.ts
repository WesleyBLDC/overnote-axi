/**
 * `<note>` reference parsing and resolution (slice: foundation). See docs/DESIGN.md
 * "Note references".
 *
 * Accepted forms, tried in this order:
 * 1. `current`: the note Overnote last showed.
 * 2. A full 26 char ULID (case-insensitive).
 * 3. `title:<text>`: the display title equals <text> after folding.
 * 4. A unique id prefix or suffix of at least 6 characters.
 *
 * Resolution failures are AxiErrors: NOTE_NOT_FOUND, AMBIGUOUS_NOTE (with up to 5 candidate
 * rows in `details` and `read <id>` hints), and NOTE_TRASHED when `allowTrashed` is false.
 */
import type { Note, NoteRef, NotesReader, ResolveOptions } from "../domain/types.js";
import { notImplemented } from "../errors.js";

export const MIN_FRAGMENT_LENGTH = 6;

export function parseRef(_raw: string): NoteRef {
  throw notImplemented("parseRef");
}

export function resolveNote(_reader: NotesReader, _raw: string, _options: ResolveOptions): Note {
  throw notImplemented("resolveNote");
}
