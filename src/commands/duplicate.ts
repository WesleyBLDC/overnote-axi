/**
 * `duplicate <note>`. A fresh, unpinned copy; `current` keeps naming the note it named.
 *
 * Without `--suffix` the copy is an exact `notes.duplicate { id }`, on every helper. With it, the
 * suffixed content (core's `duplicateContent` rule, built from the fresh `notes.get` of the
 * source, read last) goes in that same call, so no copy ever exists without its suffix. Sending
 * content needs helper 0.5.0 (protocol v3.0) or newer, checked with `system.ping` before any read.
 */
import { flagString, ok, type CommandSpec } from "../command.js";
import type { NotesWriter } from "../domain/types.js";
import { axiError } from "../errors.js";
import { resolveNote, trashedError } from "../store/refs.js";
import { renderNewNote } from "./create.js";
import { keepCurrent, resolveFresh, storedCurrent } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

/** The first helper release whose `notes.duplicate` takes the copy's content (protocol v3.0). */
const CONTENT_HELPER = [0, 5, 0] as const;

/** True for a `major.minor.patch` version at or after CONTENT_HELPER; anything unparsable is not. */
function takesContent(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  for (let i = 0; i < 3; i++) {
    const part = Number(match[i + 1]);
    if (part !== CONTENT_HELPER[i]) return part > CONTENT_HELPER[i]!;
  }
  return true;
}

/** Refuses `--suffix` on a helper too old to take content, before anything is written. */
async function requireContentHelper(writer: NotesWriter, id: string): Promise<void> {
  const { version } = await writer.ping();
  if (takesContent(version)) return;
  throw axiError(
    `duplicate --suffix needs Overnote helper ${CONTENT_HELPER.join(".")} or newer, and the running helper is ${version}; update Overnote, then run overnote-axi open`,
    "HELPER_ERROR",
    ["overnote-axi open", `overnote-axi duplicate ${id}`],
    { helperVersion: version },
  );
}

export const command: CommandSpec = {
  name: "duplicate",
  positionals: [NOTE_ARG],
  flags: [
    { name: "suffix", type: "string", value: "<text>", description: "Text added at the end of the copy's title line" },
  ],
  notes: [
    "The copy is a new unpinned note and current keeps naming the same note; notes in Recently Deleted are refused",
    "--suffix goes into the copy's first line itself, so the title and the note agree; it needs Overnote helper 0.5.0 or newer",
  ],
  examples: ["overnote-axi duplicate current", 'overnote-axi duplicate RN7Q3K --suffix " (draft)"'],
  run: async (args, context) => {
    const ref = args.positionals[0]!;
    const suffix = flagString(args, "suffix") ?? "";
    // The local lookup, the version ping and the core load come first, so the fresh read is right
    // before the write and the old helper hint can name the resolved id.
    let converter;
    if (suffix !== "") {
      const { id } = context.reader().snapshot((reader) => resolveNote(reader, ref, { allowTrashed: true, command: "duplicate" }));
      await requireContentHelper(await context.writer(), id);
      converter = await context.converter();
    }
    const { writer, note: source } = await resolveFresh(context, ref, "duplicate");
    if (source.deletedAt !== null) throw trashedError(source);
    const content = converter?.duplicateContent(source, suffix);
    const previous = storedCurrent(context);
    const copy = await writer.duplicate(source.id, content);
    const warning = await keepCurrent(context, writer, previous, copy.id);
    return ok(renderNewNote("duplicated", copy, { from: source.id }, warning));
  },
};
