/**
 * `delete <note>` (slice: write commands). Moves to Recently Deleted (recoverable for 60 days);
 * a note already there is a no-op. `--permanent` erases it, the only irreversible path.
 */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "delete",
  positionals: [NOTE_ARG],
  flags: [{ name: "permanent", type: "boolean", description: "Erase the note instead of moving it to Recently Deleted" }],
  notes: ["Without --permanent the note can be restored with recover for 60 days"],
  examples: ["overnote-axi delete 01JABCDEF", "overnote-axi delete 01JABCDEF --permanent"],
  run: async () => {
    throw notImplemented("delete");
  },
};
