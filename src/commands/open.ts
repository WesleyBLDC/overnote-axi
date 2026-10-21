/** `open [note]` (slice: read commands). Shows a note, or the last one, via a Raycast deeplink. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "open",
  positionals: [{ ...NOTE_ARG, required: false }],
  flags: [],
  notes: ["Opening Overnote also starts its helper, which writes need"],
  examples: ["overnote-axi open", "overnote-axi open current"],
  run: async () => {
    throw notImplemented("open");
  },
};
