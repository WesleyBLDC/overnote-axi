/**
 * `trash` (slice: write commands). Lists Recently Deleted from the read-only database;
 * `--empty --permanent` erases all of it through the helper. `--empty` alone is a usage error.
 */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { DEFAULT_LIST_FIELDS, fieldsFlag, LIST_FIELDS, limitFlag, OFFSET_FLAG } from "./shared.js";

export const command: CommandSpec = {
  name: "trash",
  positionals: [],
  flags: [
    limitFlag(50),
    OFFSET_FLAG,
    fieldsFlag(LIST_FIELDS, ["id", "title", "deleted"]),
    { name: "empty", type: "boolean", description: "Erase every note in Recently Deleted (needs --permanent)" },
    { name: "permanent", type: "boolean", description: "Confirms that --empty erases notes for good" },
  ],
  notes: [`Default columns: id,title,deleted (list defaults are ${DEFAULT_LIST_FIELDS.join(",")})`],
  examples: ["overnote-axi trash", "overnote-axi trash --empty --permanent"],
  run: async () => {
    throw notImplemented("trash");
  },
};
