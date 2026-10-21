/**
 * `setup [hooks|skill]` (slice: integrations). Installs, repairs, or with --uninstall removes the
 * SessionStart hook (default) or the agent skill. Idempotent; never touches unrelated settings.
 */
import type { CommandSpec } from "../command.js";
import { notImplemented } from "../errors.js";

export const command: CommandSpec = {
  name: "setup",
  positionals: [
    { name: "<target>", description: "What to install", required: false, choices: ["hooks", "skill"] },
  ],
  flags: [
    { name: "uninstall", type: "boolean", description: "Remove instead of install" },
    {
      name: "agent",
      type: "list",
      value: "<a,b>",
      choices: ["claude", "codex", "opencode"],
      default: "every agent found on this machine",
      description: "Agents to configure",
    },
  ],
  notes: ["Hooks run overnote-axi home at session start, so agents begin with your notes in view"],
  examples: ["overnote-axi setup", "overnote-axi setup skill", "overnote-axi setup --uninstall --agent claude"],
  run: async () => {
    throw notImplemented("setup");
  },
};
