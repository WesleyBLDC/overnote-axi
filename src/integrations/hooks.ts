/**
 * Session hook installation for Claude Code, Codex and OpenCode (slice: integrations).
 * See docs/DESIGN.md section 8 "Ambient context: setup".
 *
 * - Claude Code: `~/.claude/settings.json`, a `hooks.SessionStart[]` entry
 *   `{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }`.
 * - Codex: `$CODEX_HOME/hooks.json` (default `~/.codex`) SessionStart entry with the same
 *   timeout, plus `hooks = true` under `[features]` in `config.toml`, edited line by line (no
 *   TOML parser): add the key under an existing `[features]` table or append the table, never
 *   rewrite other lines, and leave the flag in place on uninstall because other tools rely on it.
 * - OpenCode: `$XDG_CONFIG_HOME/opencode/plugins/overnote-axi.js` (default `~/.config`), whose
 *   first line is OPENCODE_MARKER. A file without the marker is never overwritten or removed;
 *   that agent alone reports IO_ERROR.
 *
 * Every write is atomic (temp file plus rename in the same directory) and keeps the file mode.
 * JSON entries are recognized by the `overnote-axi` marker in the command; a repeat install with
 * the same command and timeout is `unchanged`, a different command or timeout is `updated`.
 * Results are per agent, so one agent's failure never hides another's success.
 *
 * All locations come from the HookEnv (built from Context.env and Context.home), never from
 * os.homedir(), so tests that point HOME at a temp dir can never reach real agent config.
 */
import { notImplemented } from "../errors.js";

export type AgentId = "claude" | "codex" | "opencode";

/** Seconds each hook entry may run; the SDK every reference AXI uses writes the same value. */
export const HOOK_TIMEOUT_SECONDS = 10;

/** The first line of the managed OpenCode plugin. */
export const OPENCODE_MARKER = "// managed by overnote-axi setup; remove with: overnote-axi setup --uninstall";

/** What the hook runs after the binary: the home view, kept short for per session cost. */
export const HOOK_ARGS = "home --limit 3 --pinned-limit 3";

export interface HookTarget {
  agent: AgentId;
  /** The config file this agent's hook lives in. */
  file: string;
}

export type HookChange = "installed" | "updated" | "unchanged" | "removed" | "absent" | "error";

export interface HookResult {
  agent: AgentId;
  file: string;
  change: HookChange;
  /** Set when change is `error`: an AxiError code such as IO_ERROR. */
  code?: string;
}

export interface HookEnv {
  home: string;
  /** `CODEX_HOME`, else `<home>/.codex`. */
  codexHome: string;
  /** `XDG_CONFIG_HOME`, else `<home>/.config`. */
  xdgConfigHome: string;
  /** From hookCommand(). */
  command: string;
}

/** Agents whose config directory exists. */
export function detectAgents(_env: HookEnv): AgentId[] {
  throw notImplemented("detectAgents");
}

export function installHooks(_env: HookEnv, _agents: readonly AgentId[]): HookResult[] {
  throw notImplemented("installHooks");
}

export function uninstallHooks(_env: HookEnv, _agents: readonly AgentId[]): HookResult[] {
  throw notImplemented("uninstallHooks");
}

export interface CommandSource {
  /** Context.binPath: the script Node is running. */
  binPath: string;
  /** process.execPath: the Node that is running it now (known to be new enough). */
  execPath: string;
  /** PATH from Context.env. */
  pathEnv: string | undefined;
}

/**
 * The command a hook or an installed skill runs.
 * - The bare `overnote-axi` when PATH resolves that name to the same real file as binPath.
 * - Otherwise `"<execPath>" "<realpath of binPath>"`, both absolute and quoted, so the hook
 *   never picks up an older `node` from the agent's PATH.
 * - binPath ending in `.ts`, or not being `dist/overnote-axi.js` or an installed bin that
 *   resolves to it, is VALIDATION_ERROR: a dev run (tsx, vitest) must never register a hook
 *   that points at source.
 */
export function hookCommand(_source: CommandSource): string {
  throw notImplemented("hookCommand");
}
