/** `update <note>` (slice: write commands). Append by default; prepend; replace behind the guard. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { CONTENT_FLAGS, EXPECTED_UPDATED_AT_FLAG, NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "update",
  positionals: [NOTE_ARG],
  flags: [
    ...CONTENT_FLAGS,
    { name: "append", type: "boolean", description: "Add after the existing content (the default)" },
    { name: "prepend", type: "boolean", description: "Add before the existing content" },
    { name: "replace", type: "boolean", description: "Replace the whole note (needs --expected-updated-at)" },
    EXPECTED_UPDATED_AT_FLAG,
  ],
  notes: [
    "Appending text the note already ends with is a no-op",
    "A note edited since --expected-updated-at fails with STALE_WRITE and changes nothing",
  ],
  examples: [
    'overnote-axi update current --content "- [ ] call Sam"',
    'overnote-axi update 01JABCDEF --prepend --content "**Today**"',
    "overnote-axi update 01JABCDEF --replace --content-file note.md --expected-updated-at 1792543271491",
  ],
  run: async () => {
    throw notImplemented("update");
  },
};
