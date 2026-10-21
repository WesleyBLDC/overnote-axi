/** `unpin <note>`. Idempotent: an unpinned note is a no-op. */
import { ok, type CommandSpec } from "../command.js";
import { renderDetail } from "../output/render.js";
import { noteLabel, resolveFresh } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "unpin",
  positionals: [NOTE_ARG],
  flags: [],
  examples: ["overnote-axi unpin RN7Q3K"],
  run: async (args, context) => {
    // Notes in Recently Deleted are never pinned, so they report a no-op too.
    const { writer, note } = await resolveFresh(context, args.positionals[0]!, "unpin");
    if (note.pinned === null) return ok(renderDetail({ unpinned: `${noteLabel(note)} (no-op; not pinned)` }));
    const unpinned = await writer.unpin(note.id);
    return ok(renderDetail({ unpinned: noteLabel(unpinned) }));
  },
};
