/** `recover <note>` (slice: write commands). Idempotent: a live note is a no-op. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "recover",
  positionals: [NOTE_ARG],
  flags: [],
  notes: ["Recovered notes come back unpinned, as in the app"],
  examples: ["overnote-axi recover 01JABCDEF"],
  run: async () => {
    throw notImplemented("recover");
  },
};
