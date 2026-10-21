/** `pin <note>` (slice: write commands). Idempotent: an already pinned note is a no-op. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "pin",
  positionals: [NOTE_ARG],
  flags: [],
  examples: ["overnote-axi pin current"],
  run: async () => {
    throw notImplemented("pin");
  },
};
