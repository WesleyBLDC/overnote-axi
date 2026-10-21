/** `duplicate <note>`. A fresh, unpinned copy; `current` keeps naming the note it named. */
import { flagString, ok, type CommandSpec } from "../command.js";
import { trashedError } from "../store/refs.js";
import { renderNewNote } from "./create.js";
import { keepCurrent, resolveFresh, storedCurrent } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "duplicate",
  positionals: [NOTE_ARG],
  flags: [{ name: "suffix", type: "string", value: "<text>", description: "Text appended to the copy's title" }],
  notes: ["The copy is a new unpinned note and current keeps naming the same note; notes in Recently Deleted are refused"],
  examples: ["overnote-axi duplicate current", 'overnote-axi duplicate RN7Q3K --suffix " (draft)"'],
  run: async (args, context) => {
    const { writer, note: source } = await resolveFresh(context, args.positionals[0]!, "duplicate");
    if (source.deletedAt !== null) throw trashedError(source);
    const suffix = flagString(args, "suffix");
    const previous = storedCurrent(context);
    const copy = await writer.duplicate(source.id, suffix === "" ? undefined : suffix);
    const warning = await keepCurrent(context, writer, previous, copy.id);
    return ok(renderNewNote("duplicated", copy, { from: source.id }, warning));
  },
};
