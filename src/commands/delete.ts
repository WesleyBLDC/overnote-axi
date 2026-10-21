/**
 * `delete <note>`. Moves to Recently Deleted (recoverable for 60 days);
 * a note already there is a no-op. `--permanent` erases it, the only irreversible path:
 * it accepts only a full id (a fragment or title is a usage error whose message names the
 * resolved id, and no hint offers the erase; `current` is refused), trashes a live note first,
 * re-reads it with notes.get and confirms `deletedAt` before notes.permanentlyDelete, reports a
 * NOTE_NOT_FOUND from that call as a no-op, and re-reads the note afterwards: the helper skips
 * a note that was recovered in between, which is a HELPER_ERROR, not an erase.
 */
import { flagBoolean, ok, type CommandOutput, type CommandSpec } from "../command.js";
import type { Context } from "../context.js";
import type { Note, NoteId, NotesWriter } from "../domain/types.js";
import { AxiError, axiError, validation } from "../errors.js";
import { joinBlocks, renderDetail, renderHelp } from "../output/render.js";
import { parseRef, resolveNote } from "../store/refs.js";
import { noOp, noteLabel as label } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

function isNotFound(error: unknown): boolean {
  return error instanceof AxiError && error.code === "NOTE_NOT_FOUND";
}

/** `notes.get`, or null when the helper says the note does not exist. */
async function getOrNull(writer: NotesWriter, id: NoteId): Promise<Note | null> {
  try {
    return await writer.get(id);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function alreadyErased(id: NoteId): CommandOutput {
  return ok(renderDetail({ deleted: `${id} ${noOp("already erased")}` }));
}

function resolveAny(context: Context, raw: string): Note {
  return context.reader().snapshot((reader) => resolveNote(reader, raw, { allowTrashed: true, command: "delete" }));
}

async function softDelete(context: Context, raw: string): Promise<CommandOutput> {
  const note = resolveAny(context, raw);
  const hint = renderHelp([`overnote-axi recover ${note.id}`]);
  if (note.deletedAt !== null) {
    return ok(joinBlocks([renderDetail({ deleted: `${label(note)} ${noOp("already in Recently Deleted")}` }), hint]));
  }
  await (await context.writer()).trash(note.id);
  return ok(joinBlocks([renderDetail({ deleted: `${label(note)} (in Recently Deleted)` }), hint]));
}

async function permanentDelete(context: Context, raw: string): Promise<CommandOutput> {
  const ref = parseRef(raw);
  if (ref.kind === "current") {
    throw validation("delete --permanent does not accept current; pass the note's full id", [
      "overnote-axi read current --meta",
    ]);
  }
  if (ref.kind !== "id") {
    // Never erase on a guess: show what the reference resolves to and let the caller repeat it.
    const note = resolveAny(context, raw);
    throw validation(`delete --permanent needs the full 26 character id; '${raw.trim()}' is ${label(note)}`, [
      `overnote-axi read ${note.id} --meta`,
    ]);
  }

  const writer = await context.writer();
  let note = await getOrNull(writer, ref.id);
  if (note === null) return ok(renderDetail({ deleted: `${ref.id} ${noOp("no note with this id exists")}` }));
  if (note.deletedAt === null) {
    await writer.trash(note.id);
    note = await getOrNull(writer, ref.id);
    if (note === null) return alreadyErased(ref.id);
    if (note.deletedAt === null) {
      throw axiError("Overnote did not move the note to Recently Deleted, so it was not erased", "HELPER_ERROR", [
        "overnote-axi status",
        `overnote-axi read ${ref.id} --meta`,
      ]);
    }
  }
  try {
    await writer.permanentlyDelete(note.id);
  } catch (error) {
    if (isNotFound(error)) return alreadyErased(ref.id);
    throw error;
  }
  // The helper skips a note that left Recently Deleted in the meantime, without an error.
  const after = await getOrNull(writer, ref.id);
  if (after !== null) {
    const state = after.deletedAt === null ? "it was recovered meanwhile" : "it is still in Recently Deleted";
    throw axiError(`Overnote did not erase the note; ${state}`, "HELPER_ERROR", [`overnote-axi read ${ref.id} --meta`], {
      id: ref.id,
    });
  }
  return ok(renderDetail({ deleted: `${label(note)} (erased permanently)` }));
}

export const command: CommandSpec = {
  name: "delete",
  positionals: [NOTE_ARG],
  flags: [{ name: "permanent", type: "boolean", description: "Erase the note instead of moving it to Recently Deleted" }],
  notes: [
    "Without --permanent the note can be restored with recover for 60 days",
    "--permanent needs the full 26 character id and does not accept current",
  ],
  examples: ["overnote-axi delete RN7Q3K", "overnote-axi delete 01JB8ZQ4M6T2X9VW3KD5RN7Q3K --permanent"],
  run: async (args, context) => {
    const raw = args.positionals[0]!;
    return flagBoolean(args, "permanent") ? permanentDelete(context, raw) : softDelete(context, raw);
  },
};
