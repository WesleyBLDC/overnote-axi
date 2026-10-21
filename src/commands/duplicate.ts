/**
 * `duplicate <note>`. A fresh, unpinned copy; `current` keeps naming the note it named.
 *
 * The copy is always an exact `notes.duplicate { id }`. With `--suffix`, the suffixed content
 * (core's `duplicateContent` rule) is then written to the copy with `notes.update`, so the title
 * and the document agree on every helper: helpers before protocol v3.0 store `titleSuffix` in the
 * title only, and v3.0 refuses it.
 */
import { flagString, ok, type CommandSpec } from "../command.js";
import type { MarkdownConverter, Note, NotesWriter } from "../domain/types.js";
import { AxiError, axiError } from "../errors.js";
import { trashedError } from "../store/refs.js";
import { renderNewNote } from "./create.js";
import { keepCurrent, resolveFresh, storedCurrent } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

/** Hints after the copy landed but its suffix did not: look at it, never duplicate again. */
function copyHints(id: string): string[] {
  return [`overnote-axi read ${id}`, `overnote-axi edit ${id} --old "<title line>" --new "<title line with suffix>"`];
}

/** Writes the suffixed content to the fresh copy, guarded by the copy's own `updatedAt`. */
async function addSuffix(writer: NotesWriter, converter: MarkdownConverter, copy: Note, suffix: string): Promise<Note> {
  const content = converter.duplicateContent(copy, suffix);
  let result;
  try {
    result = await writer.update({ id: copy.id, ...content, expectedUpdatedAt: copy.updatedAt });
  } catch (error) {
    const cause = error instanceof AxiError ? error : null;
    throw axiError(
      `duplicated ${copy.id}, but adding the suffix failed${cause ? ` (${cause.message})` : ""}; do not duplicate it again`,
      cause?.code ?? "HELPER_ERROR",
      copyHints(copy.id),
      { id: copy.id },
    );
  }
  if (result.status === "conflict") {
    throw axiError(
      `duplicated ${copy.id}, but the copy changed before the suffix was written, so it keeps the source's title; do not duplicate it again`,
      "STALE_WRITE",
      copyHints(copy.id),
      { id: copy.id, updatedAt: result.note.updatedAt },
    );
  }
  return result.note;
}

export const command: CommandSpec = {
  name: "duplicate",
  positionals: [NOTE_ARG],
  flags: [
    { name: "suffix", type: "string", value: "<text>", description: "Text added at the end of the copy's title line" },
  ],
  notes: [
    "The copy is a new unpinned note and current keeps naming the same note; notes in Recently Deleted are refused",
    "--suffix goes into the copy's first line itself, so the title and the note agree",
  ],
  examples: ["overnote-axi duplicate current", 'overnote-axi duplicate RN7Q3K --suffix " (draft)"'],
  run: async (args, context) => {
    const { writer, note: source } = await resolveFresh(context, args.positionals[0]!, "duplicate");
    if (source.deletedAt !== null) throw trashedError(source);
    const suffix = flagString(args, "suffix") ?? "";
    // Load the core chunk before the copy exists, so a load failure leaves no half made copy.
    const converter = suffix === "" ? null : await context.converter();
    const previous = storedCurrent(context);
    let copy = await writer.duplicate(source.id);
    const warning = await keepCurrent(context, writer, previous, copy.id);
    if (converter) copy = await addSuffix(writer, converter, copy, suffix);
    return ok(renderNewNote("duplicated", copy, { from: source.id }, warning));
  },
};
