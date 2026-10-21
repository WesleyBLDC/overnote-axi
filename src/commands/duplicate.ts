/** `duplicate <note>` (slice: write commands). A fresh, unpinned copy. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "duplicate",
  positionals: [NOTE_ARG],
  flags: [{ name: "suffix", type: "string", value: "<text>", description: "Text appended to the copy's title" }],
  examples: ["overnote-axi duplicate current", 'overnote-axi duplicate 01JABCDEF --suffix " (draft)"'],
  run: async () => {
    throw notImplemented("duplicate");
  },
};
