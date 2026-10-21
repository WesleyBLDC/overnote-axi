/** `read <note>...` (slice: read commands). Metadata plus markdown, truncated unless --full. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "read",
  positionals: [{ ...NOTE_ARG, variadic: true }],
  flags: [
    { name: "full", type: "boolean", description: "Do not truncate the body" },
    { name: "meta", type: "boolean", description: "Metadata only, no body" },
    {
      name: "format",
      type: "string",
      value: "<format>",
      choices: ["markdown", "text"],
      default: "markdown",
      description: "Body as markdown or as plain text",
    },
  ],
  notes: ["updatedAt is the value to pass as --expected-updated-at to update and edit"],
  examples: ["overnote-axi read current", "overnote-axi read 01JABCDEF --full", "overnote-axi read title:Groceries --meta"],
  run: async () => {
    throw notImplemented("read");
  },
};
