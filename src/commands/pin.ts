/** `pin <note>`. Idempotent: an already pinned note is a no-op. */
import { ok, type CommandSpec } from "../command.js";
import { renderDetail } from "../output/render.js";
import { trashedError } from "../store/refs.js";
import { noteLabel, pinPosition, positionText, resolveFresh } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "pin",
  positionals: [NOTE_ARG],
  flags: [],
  notes: ["Pins go to the end of the pinned list; reorder them with move"],
  examples: ["overnote-axi pin current"],
  run: async (args, context) => {
    const { writer, note } = await resolveFresh(context, args.positionals[0]!, "pin");
    if (note.deletedAt !== null) throw trashedError(note);
    if (note.pinned !== null) {
      const { position, total } = pinPosition(context, note.id);
      return ok(renderDetail({ pinned: `${noteLabel(note)} (no-op; already at position ${position ?? "?"} of ${total})` }));
    }
    const pinned = await writer.pin(note.id);
    return ok(renderDetail({ pinned: `${noteLabel(pinned)} ${positionText(pinPosition(context, pinned.id))}` }));
  },
};
