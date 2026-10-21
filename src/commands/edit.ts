/**
 * `edit <note>` (slice: write commands). Exact text replacement inside the markdown, block
 * scoped through converter.edit, written through writeContent (src/commands/write-flow.ts).
 */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { ALLOW_LOSS_FLAG, EXPECTED_UPDATED_AT_FLAG, NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "edit",
  positionals: [NOTE_ARG],
  flags: [
    { name: "old", type: "string", value: "<text>", description: "Exact markdown to find (required)" },
    { name: "new", type: "string", value: "<text>", description: "Replacement markdown; --new= deletes (required)" },
    { name: "all", type: "boolean", description: "Replace every occurrence instead of exactly one" },
    EXPECTED_UPDATED_AT_FLAG,
    ALLOW_LOSS_FLAG,
  ],
  notes: [
    "Matches the markdown that read shows, so copy text from read output",
    "Only the blocks that contain the match are rewritten; the rest of the note is untouched",
  ],
  examples: [
    'overnote-axi edit current --old "- [ ] ship" --new "- [x] ship"',
    'overnote-axi edit 01JABCDEF --old "2025" --new "2026" --all',
  ],
  run: async () => {
    throw notImplemented("edit");
  },
};
