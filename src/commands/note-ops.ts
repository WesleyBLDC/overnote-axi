/**
 * Small pieces the organize and content write commands share: resolving a note and reading it
 * fresh through the helper, pin positions, the one line labels their confirmations print, and
 * the no-op token every write uses.
 */
import { displayTitle } from "@overnote/core/text";

import type { Context } from "../context.js";
import type { Note, NoteId, NotesWriter } from "../domain/types.js";
import { AxiError } from "../errors.js";
import { resolveNote } from "../store/refs.js";
import { pinPosition as positionIn, type PinPosition } from "./note-columns.js";

export type { PinPosition } from "./note-columns.js";

/** `(no-op; <reason>)`: the one marker every write prints when it changed nothing. */
export function noOp(reason: string): string {
  return `(no-op; ${reason})`;
}

/** `01JAB3K9QW Standup`: the id and display title an organize confirmation prints. */
export function noteLabel(note: Pick<Note, "id" | "title" | "text">): string {
  return `${note.id} ${displayTitle(note)}`;
}

export interface FreshNote {
  writer: NotesWriter;
  /** The note as the helper has it right now (organize decisions never trust an older read). */
  note: Note;
}

/**
 * Resolves `<note>` from SQLite (trashed notes included, so callers word their own result) and
 * reads it again through the helper, which is what every organize decision is based on.
 */
export async function resolveFresh(context: Context, ref: string, command: string): Promise<FreshNote> {
  const resolved = context.reader().snapshot((reader) => resolveNote(reader, ref, { allowTrashed: true, command }));
  const writer = await context.writer();
  return { writer, note: await writer.get(resolved.id) };
}

/** Where a note sits in the pinned list, read from one snapshot after the write. */
export function pinPosition(context: Context, id: NoteId): PinPosition {
  return context.reader().snapshot((reader) => positionIn(reader, id));
}

/** `(position 2 of 4)`. */
export function positionText({ position, total }: PinPosition): string {
  return position === null ? "(not pinned)" : `(position ${position} of ${total})`;
}

/** The stored current note id before a write, or null when there is none or it cannot be read. */
export function storedCurrent(context: Context): NoteId | null {
  try {
    return context.reader().snapshot((reader) => reader.currentNoteId());
  } catch {
    return null;
  }
}

/**
 * Helpers before Overnote's fix persist every new note (create, duplicate) as the current note,
 * so `current` would name the agent's note while the panel shows another. When that happened,
 * put the previous current note back. Returns a warning when the restore itself failed.
 */
export async function keepCurrent(
  context: Context,
  writer: NotesWriter,
  previous: NoteId | null,
  created: NoteId,
): Promise<string | undefined> {
  if (previous === null || previous === created) return undefined;
  if (storedCurrent(context) !== created) return undefined;
  try {
    await writer.setCurrentNote(previous);
    return undefined;
  } catch (error) {
    const reason = error instanceof AxiError ? error.message : "the helper refused";
    return `current now names this note, because restoring the previous current note failed (${reason})`;
  }
}
