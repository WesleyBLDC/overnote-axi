/**
 * `overnote-axi` / `overnote-axi home` (slice: read commands). Content first (AXI principle 8):
 * bin and description, helper state, counts, the current note, pinned and recent rows, hints.
 * Never fails on a missing database or a stopped helper: it says so in the output and exits 0,
 * because the session hook runs it at every session start.
 */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";

export const command: CommandSpec = {
  name: "home",
  positionals: [],
  flags: [
    {
      name: "limit",
      type: "number",
      value: "<n>",
      min: 0,
      max: 50,
      default: "5",
      description: "Recent notes to show",
    },
  ],
  examples: ["overnote-axi", "overnote-axi home --limit 3"],
  run: async () => {
    throw notImplemented("home");
  },
};
