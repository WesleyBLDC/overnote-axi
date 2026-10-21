/** `list` (slice: read commands). Live notes in app order: pinned first, then newest. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { DEFAULT_LIST_FIELDS, fieldsFlag, LIST_FIELDS, limitFlag, OFFSET_FLAG } from "./shared.js";

export const command: CommandSpec = {
  name: "list",
  positionals: [],
  flags: [
    limitFlag(50),
    OFFSET_FLAG,
    { name: "pinned", type: "boolean", description: "Only pinned notes, in pin order" },
    {
      name: "sort",
      type: "string",
      value: "<order>",
      choices: ["updated", "accessed", "created"],
      default: "updated",
      description: "Order after the pinned notes, newest first",
    },
    fieldsFlag(LIST_FIELDS, DEFAULT_LIST_FIELDS),
  ],
  examples: ["overnote-axi list", "overnote-axi list --pinned", "overnote-axi list --sort accessed --fields id,title,accessed"],
  run: async () => {
    throw notImplemented("list");
  },
};
