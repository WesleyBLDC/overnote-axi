/**
 * `status` (slice: read commands). Helper, database, schema and path diagnostics, plus `build`
 * (VERSION and CORE_REVISION from src/build-info.ts, the Overnote commit core was bundled from).
 */
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
