/** `create` (slice: write commands). A new note from markdown, converted with @overnote/core. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { CONTENT_FLAGS } from "./shared.js";

export const command: CommandSpec = {
  name: "create",
  positionals: [],
  flags: [
    ...CONTENT_FLAGS,
    { name: "title", type: "string", value: "<text>", description: "Heading placed above the content as # <text>" },
    { name: "pin", type: "boolean", description: "Pin the new note" },
    { name: "open", type: "boolean", description: "Show the new note in the Overnote panel" },
  ],
  notes: ["The title is the first line of the note, as in the app", "Give --title, --content, or both"],
  examples: [
    'overnote-axi create --title "Standup" --content "- [ ] demo"',
    "overnote-axi create --content-file notes.md --pin",
    'printf "# Draft" | overnote-axi create --content -',
  ],
  run: async () => {
    throw notImplemented("create");
  },
};
