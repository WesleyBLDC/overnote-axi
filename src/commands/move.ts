/** `move <note> up|down` (slice: write commands). Reorders the pinned list; no-op at the ends. */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "move",
  positionals: [NOTE_ARG, { name: "<direction>", description: "Where to move it", required: true, choices: ["up", "down"] }],
  flags: [
    {
      name: "steps",
      type: "number",
      value: "<n>",
      min: 1,
      max: 100,
      default: "1",
      description: "Positions to move",
    },
  ],
  examples: ["overnote-axi move 01JABCDEF up", "overnote-axi move current down --steps 2"],
  run: async () => {
    throw notImplemented("move");
  },
};
