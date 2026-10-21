/** `status` (slice: read commands). Helper, database, schema and path diagnostics. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";

export const command: CommandSpec = {
  name: "status",
  positionals: [],
  flags: [],
  examples: ["overnote-axi status"],
  run: async () => {
    throw notImplemented("status");
  },
};
