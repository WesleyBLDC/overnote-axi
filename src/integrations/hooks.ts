/**
 * Session hook installation for Claude Code, Codex and OpenCode (slice: integrations).
 * See docs/DESIGN.md "Ambient context: setup".
 *
 * - Claude Code: `~/.claude/settings.json`, `hooks.SessionStart[]` entry whose command runs
 *   `<bin> home --limit 3`.
 * - Codex: `~/.codex/hooks.json` SessionStart entry, plus `[features] hooks = true` in config.toml.
 * - OpenCode: a managed plugin file in `~/.config/opencode/plugins/overnote-axi.js`.
 *
 * Every write is atomic (temp file plus rename), preserves unrelated content byte for byte where
 * the format allows, and recognizes its own entries by the `overnote-axi` marker so repeated
 * installs are no-ops and a moved binary is repaired in place.
 */
import { notImplemented } from "../errors.js";

export type AgentId = "claude" | "codex" | "opencode";

export interface HookTarget {
  agent: AgentId;
  /** The config file this agent's hook lives in. */
  file: string;
}

export type HookChange = "installed" | "updated" | "unchanged" | "removed" | "absent";

export interface HookResult {
  agent: AgentId;
  file: string;
  change: HookChange;
}

export interface HookEnv {
  home: string;
  /** The command the hook runs: the bare name when PATH resolves it to this binary, else the absolute path. */
  command: string;
}

/** Agents whose config directory exists under `home`. */
export function detectAgents(_home: string): AgentId[] {
  throw notImplemented("detectAgents");
}

export function installHooks(_env: HookEnv, _agents: readonly AgentId[]): HookResult[] {
  throw notImplemented("installHooks");
}

export function uninstallHooks(_env: HookEnv, _agents: readonly AgentId[]): HookResult[] {
  throw notImplemented("uninstallHooks");
}

/** The hook command: `overnote-axi home --limit 3`, with the binary resolved as described above. */
export function hookCommand(_binPath: string, _pathEnv: string | undefined): string {
  throw notImplemented("hookCommand");
}
