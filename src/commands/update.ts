/**
 * `update <note>` (slice: write commands). Append by default; prepend; replace behind the guard.
 * Goes through writeContent (src/commands/write-flow.ts) with converter.compose for append and
 * prepend, and fromMarkdown plus rewriteLosses for replace.
 */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { ALLOW_LOSS_FLAG, CONTENT_FLAGS, EXPECTED_UPDATED_AT_FLAG, NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "update",
  positionals: [NOTE_ARG],
  flags: [
    ...CONTENT_FLAGS,
    { name: "append", type: "boolean", description: "Add after the existing content (the default)" },
    { name: "prepend", type: "boolean", description: "Add before the existing content" },
    { name: "replace", type: "boolean", description: "Replace the whole note (needs --expected-updated-at)" },
    EXPECTED_UPDATED_AT_FLAG,
    ALLOW_LOSS_FLAG,
  ],
  notes: [
    "Append and prepend keep every existing block exactly as stored",
    "Appending text the note already ends with is a no-op",
    "--replace refuses with LOSSY_REWRITE when markdown cannot hold the note's content",
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
