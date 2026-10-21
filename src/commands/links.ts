/** `links <note>` (slice: read commands). Outgoing note deeplinks and backlinks. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "links",
  positionals: [NOTE_ARG],
  flags: [],
  examples: ["overnote-axi links current"],
  run: async () => {
    throw notImplemented("links");
  },
};
