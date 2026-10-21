/**
 * `overnote-axi` / `overnote-axi home` (slice: read commands). Content first (AXI principle 8):
 * bin and description, helper state, counts, the current note, pinned and recent rows, hints.
 * Never fails on a missing database or a stopped helper: it says so in the output and exits 0,
 * because the session hook runs it at every session start. Helper state comes from
 * context.probeHelper() (short timeout), and all reads share one reader.snapshot().
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
    {
      name: "pinned-limit",
      type: "number",
      value: "<n>",
      min: 0,
      max: 9,
      default: "9",
      description: "Pinned notes to show (the session hook passes 3)",
    },
  ],
  examples: ["overnote-axi", "overnote-axi home --limit 3 --pinned-limit 3"],
  run: async () => {
    throw notImplemented("home");
  },
};
