/** `unpin <note>` (slice: write commands). Idempotent: an unpinned note is a no-op. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "unpin",
  positionals: [NOTE_ARG],
  flags: [],
  examples: ["overnote-axi unpin 01JABCDEF"],
  run: async () => {
    throw notImplemented("unpin");
  },
};
