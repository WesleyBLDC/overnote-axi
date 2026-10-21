/** `search <query>` (slice: read commands). The app's folded substring match; title hits first. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { DEFAULT_SEARCH_FIELDS, fieldsFlag, limitFlag, SEARCH_FIELDS } from "./shared.js";

export const command: CommandSpec = {
  name: "search",
  positionals: [{ name: "<query>", description: "Text to find in titles and note text", required: true }],
  flags: [
    limitFlag(20, 200),
    { name: "trash", type: "boolean", description: "Search Recently Deleted instead of live notes" },
    fieldsFlag(SEARCH_FIELDS, DEFAULT_SEARCH_FIELDS),
  ],
  notes: ["Matching ignores case and accents, like the Overnote search bar"],
  examples: ['overnote-axi search "standup"', "overnote-axi search invoice --trash"],
  run: async () => {
    throw notImplemented("search");
  },
};
