/** `link <note>` (slice: write commands). Print a note's deeplink, or insert it with --into. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "link",
  positionals: [NOTE_ARG],
  flags: [
    { name: "into", type: "string", value: "<note>", description: "Insert the link into this note" },
    { name: "text", type: "string", value: "<label>", description: "Link text (default: the linked note's title)" },
    { name: "prepend", type: "boolean", description: "Insert at the top instead of the end" },
  ],
  notes: ["Links open the note in Overnote through Raycast"],
  examples: ["overnote-axi link 01JABCDEF", "overnote-axi link 01JABCDEF --into current"],
  run: async () => {
    throw notImplemented("link");
  },
};
