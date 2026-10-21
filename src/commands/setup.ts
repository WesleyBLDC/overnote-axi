/**
 * `setup [hooks|skill]`. Installs, repairs, or with --uninstall removes the
 * SessionStart hook (default) or the agent skill. Idempotent; never touches unrelated settings.
 * See docs/DESIGN.md sections 8 and 9.
 */
import { rebuildInvocation } from "../args.js";
import { flagBoolean, flagList, type CommandSpec, type ParsedArgs } from "../command.js";
import type { Context } from "../context.js";
import { AxiError, axiError, EXIT_ERROR, validation } from "../errors.js";
import {
  AGENTS,
  agentConfigDir,
  detectAgents,
  hookLocations,
  installHooks,
  renderProgram,
  resolveProgram,
  uninstallHooks,
  type AgentId,
  type HookResult,
} from "../integrations/hooks.js";
import { buildSkill, installSkill, skillFile, skillInput, uninstallSkill } from "../integrations/skill.js";
import { NAME } from "../meta.js";
import { collapseHome, joinBlocks, renderDetail, renderHelp, rows, column, type Column } from "../output/render.js";

type Target = "hooks" | "skill";

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
  notes: [
    "Hooks run overnote-axi home at session start, so agents begin with your notes in view",
    "The skill installs for Claude Code only (~/.claude/skills/overnote-axi); the hook and the skill are two ways to the same result",
  ],
  examples: ["overnote-axi setup", "overnote-axi setup skill", "overnote-axi setup --uninstall --agent claude"],
  run: async (args, context) => {
    const target = (args.positionals[0] ?? "hooks") as Target;
    const uninstall = flagBoolean(args, "uninstall");
    const agents = flagList(args, "agent") as readonly AgentId[] | undefined;
    return target === "skill" ? setupSkill(args, context, uninstall, agents) : setupHooks(args, context, uninstall, agents);
  },
};

function program(context: Context): readonly string[] {
  return resolveProgram({ binPath: context.binPath, execPath: process.execPath, pathEnv: context.env.PATH });
}

/** Codex runs a new or modified hook only after the user reviews and trusts it. */
export const CODEX_TRUST_HINT = `Codex runs the hook only after you trust it: open Codex, run /hooks, and trust the ${NAME} hook`;

const RESULT_COLUMNS: readonly Column<HookResult>[] = [
  column("agent", (row) => row.agent),
  column("file", (row) => row.file),
  column("change", (row) => row.change),
];

const ERROR_COLUMNS: readonly Column<HookResult>[] = [
  ...RESULT_COLUMNS,
  column("code", (row) => row.code ?? ""),
  column("reason", (row) => row.reason ?? ""),
];

/** A skipped row (a file setup did not write) says why, without an error code. */
const REASON_COLUMNS: readonly Column<HookResult>[] = [...RESULT_COLUMNS, column("reason", (row) => row.reason ?? "")];

function render(
  target: Target,
  results: readonly HookResult[],
  context: Context,
  hints: readonly string[],
): { output: string; exitCode?: number } {
  const shown = results.map((row) => ({ ...row, file: collapseHome(row.file, context.home) }));
  const failed = shown.some((row) => row.change === "error");
  const skipped = shown.some((row) => row.change === "skipped");
  const columns = failed ? ERROR_COLUMNS : skipped ? REASON_COLUMNS : RESULT_COLUMNS;
  const output = joinBlocks([
    renderDetail({ setup: { target }, results: rows(shown, columns) }),
    renderHelp(hints),
  ]);
  return failed ? { output, exitCode: EXIT_ERROR } : { output };
}

async function setupHooks(
  args: ParsedArgs,
  context: Context,
  uninstall: boolean,
  requested: readonly AgentId[] | undefined,
) {
  const locations = hookLocations(context.env, context.home);
  // Uninstall looks everywhere: a missing config is simply `absent`, and nothing is created.
  const agents = requested ?? (uninstall ? AGENTS : detectAgents(locations));
  if (agents.length === 0) {
    const looked = AGENTS.map((agent) => collapseHome(agentConfigDir(locations, agent), context.home)).join(" ");
    return {
      output: joinBlocks([
        renderDetail({ setup: { target: "hooks", agents: `0 found (looked for ${looked})` } }),
        renderHelp([`${NAME} setup --agent claude`, `${NAME} setup skill`]),
      ]),
    };
  }

  const results = uninstall
    ? uninstallHooks(locations, agents)
    : installHooks({ ...locations, program: program(context) }, agents);
  const failed = results.filter((row) => row.change === "error").map((row) => row.agent);
  const written = uninstall ? [] : results.filter((row) => row.change === "installed" || row.change === "updated");
  // Codex skips a new or changed hook until the user trusts it; setup never writes that trust.
  const codexTrust = written.some((row) => row.agent === "codex") ? [CODEX_TRUST_HINT] : [];
  const hints =
    failed.length > 0
      ? [rebuildInvocation(command, args, { agent: failed }), ...codexTrust]
      : written.length > 0
        ? ["Start a new agent session to see your notes at session start", ...codexTrust, `${NAME} setup --uninstall`]
        : [];
  return render("hooks", results, context, hints);
}

async function setupSkill(
  args: ParsedArgs,
  context: Context,
  uninstall: boolean,
  requested: readonly AgentId[] | undefined,
) {
  if (requested && requested.some((agent) => agent !== "claude")) {
    throw validation("setup skill installs for Claude Code only (--agent claude)", [
      `${NAME} setup skill`,
      "npx skills add WesleyBLDC/overnote-axi --skill overnote-axi (the skills installer, for other agents)",
      `${NAME} setup --agent ${requested.join(",")} (the session hook works for every agent)`,
    ]);
  }

  let result: HookResult;
  try {
    const outcome = uninstall
      ? uninstallSkill(context.home)
      : installSkill(context.home, buildSkill(skillInput(renderProgram(program(context)))));
    result = { agent: "claude", ...outcome };
  } catch (error) {
    if (error instanceof AxiError && error.code === "VALIDATION_ERROR") throw error;
    const failure =
      error instanceof AxiError ? error : axiError("could not read or write the skill file; check its permissions", "IO_ERROR");
    result = {
      agent: "claude",
      file: skillFile(context.home),
      change: "error",
      code: failure.code,
      reason: failure.message,
    };
  }
  const hints =
    result.change === "error"
      ? [rebuildInvocation(command, args)]
      : !uninstall && result.change !== "unchanged"
        ? ["Start a new Claude Code session, then use /overnote-axi"]
        : [];
  return render("skill", [result], context, hints);
}
