/** `recover <note>`. Idempotent: a live note is a no-op. */
import { ok, type CommandSpec } from "../command.js";
import { joinBlocks, renderDetail, renderHelp } from "../output/render.js";
import { noteLabel, resolveFresh } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "recover",
  positionals: [NOTE_ARG],
  flags: [],
  notes: ["Recovered notes come back unpinned, as in the app"],
  examples: ["overnote-axi recover RN7Q3K"],
  run: async (args, context) => {
    const { writer, note } = await resolveFresh(context, args.positionals[0]!, "recover");
    if (note.deletedAt === null) {
      return ok(renderDetail({ recovered: `${noteLabel(note)} (no-op; not in Recently Deleted)` }));
    }
    const recovered = await writer.recover(note.id);
    return ok(
      joinBlocks([
        renderDetail({ recovered: noteLabel(recovered) }),
        renderHelp([`overnote-axi read ${recovered.id}`, `overnote-axi pin ${recovered.id}`]),
      ]),
    );
  },
};
