/** `edit <note>` (slice: write commands). Exact text replacement inside the markdown. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { EXPECTED_UPDATED_AT_FLAG, NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "edit",
  positionals: [NOTE_ARG],
  flags: [
    { name: "old", type: "string", value: "<text>", description: "Exact markdown to find (required)" },
    { name: "new", type: "string", value: "<text>", description: "Replacement markdown; --new= deletes (required)" },
    { name: "all", type: "boolean", description: "Replace every occurrence instead of exactly one" },
    EXPECTED_UPDATED_AT_FLAG,
  ],
  notes: ["Matches the markdown that read shows, so copy text from read output"],
  examples: [
    'overnote-axi edit current --old "- [ ] ship" --new "- [x] ship"',
    'overnote-axi edit 01JABCDEF --old "2025" --new "2026" --all',
  ],
  run: async () => {
    throw notImplemented("edit");
  },
};
