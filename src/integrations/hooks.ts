/**
 * Session hook installation for Claude Code, Codex and OpenCode.
 * See docs/DESIGN.md section 8 "Ambient context: setup".
 *
 * - Claude Code: `~/.claude/settings.json`, a `hooks.SessionStart[]` entry
 *   `{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }`.
 * - Codex: `$CODEX_HOME/hooks.json` (default `~/.codex`) SessionStart entry with the same
 *   timeout, plus `hooks = true` under `[features]` in `config.toml`, edited line by line (no
 *   TOML parser, see codex-config.ts), left in place on uninstall because other tools rely on it.
 * - OpenCode: `$XDG_CONFIG_HOME/opencode/plugins/overnote-axi.js` (default `~/.config`), whose
 *   first line is OPENCODE_MARKER. A file without the marker is never overwritten or removed:
 *   install reports IO_ERROR for that agent alone, and uninstall reports it `skipped`, since
 *   nothing of ours is there to remove.
 *
 * Every write is atomic (temp file plus rename in the same directory) and keeps the file mode.
 * A JSON entry is ours when its command runs this CLI's home view (see isOurHookCommand); a repeat
 * install with the same command and timeout is `unchanged`, a different command or timeout is
 * `updated`. Uninstall also drops a `hooks` object it left empty, and deletes a JSON file that
 * ends up as an empty object (a symlinked one is written as `{}` instead, so a dotfiles link
 * survives). Codex's two files are written as a pair: hooks.json first, then config.toml, and a
 * failed config.toml write restores hooks.json.
 * Results are per agent, so one agent's failure never hides another's success.
 *
 * All locations come from the HookLocations (built from Context.env and Context.home), never
 * from os.homedir(), so tests that point HOME at a temp dir can never reach real agent config.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { AxiError, axiError, validation, type ErrorCode } from "../errors.js";
import { NAME } from "../meta.js";
import { enableCodexHooks } from "./codex-config.js";
import { isDirectory, isSymlink, readIfExists, removeDirIfEmpty, removeFile, writeAtomic } from "./files.js";
import { openCodePluginSource } from "./opencode-plugin.js";

export type AgentId = "claude" | "codex" | "opencode";

/** Every supported agent, in the order results are reported. */
export const AGENTS: readonly AgentId[] = ["claude", "codex", "opencode"];

/** Seconds each hook entry may run; the SDK every reference AXI uses writes the same value. */
export const HOOK_TIMEOUT_SECONDS = 10;

/** The first line of the managed OpenCode plugin. */
export const OPENCODE_MARKER = "// managed by overnote-axi setup; remove with: overnote-axi setup --uninstall";

/** What the hook runs after the binary: the home view, kept short for per session cost. */
export const HOOK_ARGS = "home --limit 3 --pinned-limit 3";

/** The text that marks a hook entry as ours. */
export const HOOK_MARKER = NAME;

export interface HookTarget {
  agent: AgentId;
  /** The config file this agent's hook lives in. */
  file: string;
}

export type HookChange = "installed" | "updated" | "unchanged" | "removed" | "absent" | "skipped" | "error";

export interface HookResult {
  agent: AgentId;
  file: string;
  change: HookChange;
  /** Set when change is `error`: an AxiError code such as IO_ERROR. */
  code?: ErrorCode;
  /** Set when change is `error` or `skipped`: what happened and how to fix it, one sentence. */
  reason?: string;
}

/** Where each agent keeps its config. */
export interface HookLocations {
  home: string;
  /** `CODEX_HOME`, else `<home>/.codex`. */
  codexHome: string;
  /** `XDG_CONFIG_HOME`, else `<home>/.config`. */
  xdgConfigHome: string;
}

export interface HookEnv extends HookLocations {
  /** From resolveProgram(): the program and its leading arguments, for example `["overnote-axi"]`. */
  program: readonly string[];
}

export function hookLocations(env: Readonly<Record<string, string | undefined>>, home: string): HookLocations {
  return {
    home,
    codexHome: env.CODEX_HOME || path.join(home, ".codex"),
    xdgConfigHome: env.XDG_CONFIG_HOME || path.join(home, ".config"),
  };
}

function claudeDir(locations: HookLocations): string {
  return path.join(locations.home, ".claude");
}

function openCodeDir(locations: HookLocations): string {
  return path.join(locations.xdgConfigHome, "opencode");
}

export function hookTarget(locations: HookLocations, agent: AgentId): HookTarget {
  switch (agent) {
    case "claude":
      return { agent, file: path.join(claudeDir(locations), "settings.json") };
    case "codex":
      return { agent, file: path.join(locations.codexHome, "hooks.json") };
    case "opencode":
      return { agent, file: path.join(openCodeDir(locations), "plugins", `${NAME}.js`) };
  }
}

/** The config directory whose presence means the agent is installed. */
export function agentConfigDir(locations: HookLocations, agent: AgentId): string {
  switch (agent) {
    case "claude":
      return claudeDir(locations);
    case "codex":
      return locations.codexHome;
    case "opencode":
      return openCodeDir(locations);
  }
}

/** Agents whose config directory exists. */
export function detectAgents(locations: HookLocations): AgentId[] {
  return AGENTS.filter((agent) => isDirectory(agentConfigDir(locations, agent)));
}

/** The full command a JSON hook entry runs. */
export function hookCommandLine(program: readonly string[]): string {
  return `${renderProgram(program)} ${HOOK_ARGS}`;
}

export function installHooks(env: HookEnv, agents: readonly AgentId[]): HookResult[] {
  return forEach(env, agents, (target) => {
    switch (target.agent) {
      case "claude":
        return installJson(target.file, hookCommandLine(env.program));
      case "codex":
        return installCodex(env, target.file, hookCommandLine(env.program));
      case "opencode":
        return installOpenCode(target.file, env.program);
    }
  });
}

export function uninstallHooks(locations: HookLocations, agents: readonly AgentId[]): HookResult[] {
  return forEach(locations, agents, (target) =>
    target.agent === "opencode" ? uninstallOpenCode(target.file) : uninstallJson(target.file),
  );
}

function forEach(
  locations: HookLocations,
  agents: readonly AgentId[],
  apply: (target: HookTarget) => HookChange | Pick<HookResult, "change" | "reason">,
): HookResult[] {
  return AGENTS.filter((agent) => agents.includes(agent)).map((agent) => {
    const target = hookTarget(locations, agent);
    try {
      const outcome = apply(target);
      return typeof outcome === "string" ? { ...target, change: outcome } : { ...target, ...outcome };
    } catch (error) {
      const failure =
        error instanceof AxiError
          ? error
          : axiError(`could not read or write ${path.basename(target.file)}; check its permissions`, "IO_ERROR");
      return { ...target, change: "error", code: failure.code, reason: failure.message };
    }
  });
}

// ---------------------------------------------------------------------------
// Claude Code settings.json and Codex hooks.json share one shape
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(file: string, problem: string): AxiError {
  return axiError(`${path.basename(file)} ${problem}; fix it by hand, then run setup again`, "IO_ERROR");
}

function readJson(file: string): JsonObject | null {
  const text = readIfExists(file);
  if (text === null) return null;
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError(file, "is not valid JSON");
  }
  if (!isObject(parsed)) throw configError(file, "does not hold a JSON object");
  return parsed;
}

function writeJson(file: string, value: JsonObject): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionStart(file: string, root: JsonObject, create: boolean): unknown[] | null {
  if (root.hooks === undefined) {
    if (!create) return null;
    root.hooks = {};
  }
  const hooks = root.hooks;
  if (!isObject(hooks)) throw configError(file, "has a hooks value that is not an object");
  if (hooks.SessionStart === undefined) {
    if (!create) return null;
    hooks.SessionStart = [];
  }
  const list = hooks.SessionStart;
  if (!Array.isArray(list)) throw configError(file, "has a hooks.SessionStart value that is not an array");
  return list;
}

/** The program part of a command this CLI wrote: the bare name, or a path ending in the script or bin. */
const OUR_PROGRAM = new RegExp(`(?:^|[\\s/"])${HOOK_MARKER}(?:\\.js)?"?$`);

/**
 * True when a hook command runs this CLI's home view: the program ends in `overnote-axi` (bare,
 * a bin path, or the `dist/overnote-axi.js` script) and the arguments are HOOK_ARGS or a bare
 * `home` from an older install. A user's own command that only mentions the name, such as
 * `cd ~/code/overnote-axi && npm test`, is never ours.
 */
export function isOurHookCommand(command: string): boolean {
  for (const args of [` ${HOOK_ARGS}`, " home"]) {
    if (command.endsWith(args) && OUR_PROGRAM.test(command.slice(0, -args.length).trimEnd())) return true;
  }
  return false;
}

function isOurs(entry: unknown): entry is JsonObject {
  return isObject(entry) && typeof entry.command === "string" && isOurHookCommand(entry.command);
}

function groupHooks(group: unknown): unknown[] | null {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
}

/** Adds or repairs our SessionStart entry; returns what changed (nothing is written here). */
export function upsertSessionStartHook(file: string, root: JsonObject, command: string): HookChange {
  const list = sessionStart(file, root, true)!;
  const ours: { group: unknown[]; entry: JsonObject }[] = [];
  for (const group of list) {
    const entries = groupHooks(group);
    for (const entry of entries ?? []) if (isOurs(entry)) ours.push({ group: entries!, entry });
  }

  if (ours.length === 0) {
    list.push({ matcher: "", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
    return "installed";
  }

  const [first, ...extra] = ours;
  let changed = false;
  if (first!.entry.type !== "command" || first!.entry.command !== command || first!.entry.timeout !== HOOK_TIMEOUT_SECONDS) {
    first!.entry.type = "command";
    first!.entry.command = command;
    first!.entry.timeout = HOOK_TIMEOUT_SECONDS;
    changed = true;
  }
  // Duplicates from an older install would run the home view twice per session.
  for (const { group, entry } of extra) {
    group.splice(group.indexOf(entry), 1);
    changed = true;
  }
  if (extra.length > 0) dropEmptiedGroups(list, new Set(extra.map(({ group }) => group)));
  return changed ? "updated" : "unchanged";
}

/** Removes our SessionStart entries; true when anything was removed. */
export function removeSessionStartHook(file: string, root: JsonObject): boolean {
  const list = sessionStart(file, root, false);
  if (!list) return false;
  const touched = new Set<unknown[]>();
  for (const group of list) {
    const entries = groupHooks(group);
    if (!entries || !entries.some(isOurs)) continue;
    const kept = entries.filter((entry) => !isOurs(entry));
    entries.splice(0, entries.length, ...kept);
    touched.add(entries);
  }
  if (touched.size === 0) return false;
  dropEmptiedGroups(list, touched);
  const hooks = root.hooks as JsonObject;
  if (list.length === 0) delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return true;
}

/** Drops the groups whose hooks this run emptied; groups the user left empty stay. */
function dropEmptiedGroups(list: unknown[], touched: ReadonlySet<unknown[]>): void {
  for (let index = list.length - 1; index >= 0; index--) {
    const entries = groupHooks(list[index]);
    if (entries && touched.has(entries) && entries.length === 0) list.splice(index, 1);
  }
}

function installJson(file: string, command: string): HookChange {
  const root = readJson(file);
  const next = root ?? {};
  const change = upsertSessionStartHook(file, next, command);
  if (change !== "unchanged") writeJson(file, next);
  return change;
}

function uninstallJson(file: string): HookChange {
  const root = readJson(file);
  if (!root || !removeSessionStartHook(file, root)) return "absent";
  // Nothing but our hook was there (usually a file setup created): leave no `{}` behind.
  if (Object.keys(root).length === 0 && !isSymlink(file)) removeFile(file);
  else writeJson(file, root);
  return "removed";
}

/**
 * Codex needs both files: the hook in hooks.json and the feature flag in config.toml. Both are
 * planned before either is written, so a broken file leaves both untouched; then hooks.json is
 * written, and if the config.toml write fails, hooks.json goes back to what it was.
 */
function installCodex(env: HookEnv, hooksFile: string, command: string): HookChange {
  const before = readIfExists(hooksFile);
  const root = readJson(hooksFile) ?? {};
  const change = upsertSessionStartHook(hooksFile, root, command);
  const configFile = path.join(env.codexHome, "config.toml");
  const config = enableCodexHooks(readIfExists(configFile));
  if (change !== "unchanged") writeJson(hooksFile, root);
  if (config.changed) {
    try {
      writeAtomic(configFile, config.text);
    } catch (error) {
      if (change !== "unchanged") {
        if (before === null) removeFile(hooksFile);
        else writeAtomic(hooksFile, before);
      }
      throw error;
    }
  }
  return change === "unchanged" && config.changed ? "updated" : change;
}

// ---------------------------------------------------------------------------
// OpenCode managed plugin
// ---------------------------------------------------------------------------

function unmanagedPlugin(): AxiError {
  return axiError(
    `plugins/${NAME}.js exists and was not written by setup, so it is left alone; move it away, then run setup again`,
    "IO_ERROR",
  );
}

function isManaged(text: string): boolean {
  return text.split("\n", 1)[0] === OPENCODE_MARKER;
}

function installOpenCode(file: string, program: readonly string[]): HookChange {
  const next = openCodePluginSource({
    marker: OPENCODE_MARKER,
    program,
    args: HOOK_ARGS.split(" "),
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
  });
  const current = readIfExists(file);
  if (current === null) {
    writeAtomic(file, next);
    return "installed";
  }
  if (!isManaged(current)) throw unmanagedPlugin();
  if (current === next) return "unchanged";
  writeAtomic(file, next);
  return "updated";
}

function uninstallOpenCode(file: string): HookChange | Pick<HookResult, "change" | "reason"> {
  const current = readIfExists(file);
  if (current === null) return "absent";
  // Not ours, so there is nothing to remove; an error here would only invite the same retry.
  if (!isManaged(current)) return { change: "skipped", reason: "not written by setup, so it is left alone" };
  removeFile(file);
  removeDirIfEmpty(path.dirname(file));
  return "removed";
}

// ---------------------------------------------------------------------------
// The command a hook or an installed skill runs
// ---------------------------------------------------------------------------

export interface CommandSource {
  /** Context.binPath: the script Node is running. */
  binPath: string;
  /** process.execPath: the Node that is running it now (known to be new enough). */
  execPath: string;
  /** PATH from Context.env. */
  pathEnv: string | undefined;
}

function notBuilt(binPath: string): AxiError {
  return validation(`setup must run from the built CLI, not ${binPath}`, [
    "npm run build",
    `node dist/${NAME}.js setup`,
  ]);
}

function realpathOrNull(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a shell would run for `name`: the first executable file of that name on PATH. */
function whichOnPath(name: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * A path to the running Node that survives an upgrade: the `node` on PATH when it is the same
 * real file as execPath (Homebrew's `/opt/homebrew/bin/node` for a versioned Cellar execPath),
 * else execPath itself. A different `node` on PATH is never used.
 */
function stableNode(execPath: string, pathEnv: string | undefined): string {
  const onPath = whichOnPath("node", pathEnv);
  if (!onPath || onPath === execPath) return execPath;
  const real = realpathOrNull(execPath);
  return real !== null && realpathOrNull(onPath) === real ? onPath : execPath;
}

/**
 * The program a hook or an installed skill runs, as argv.
 * - `["overnote-axi"]` when PATH resolves that name to the same real file as binPath.
 * - Otherwise `[node, realpath of binPath]`, both absolute, so the hook never picks up an
 *   older `node` from the agent's PATH. `node` is stableNode(): the PATH entry for the same
 *   real Node when there is one, so a Homebrew upgrade does not break the hook.
 * - binPath ending in `.ts`, or not being `dist/overnote-axi.js` or an installed bin that
 *   resolves to it, is VALIDATION_ERROR: a dev run (tsx, vitest) must never register a hook
 *   that points at source.
 */
export function resolveProgram(source: CommandSource): readonly string[] {
  if (source.binPath.endsWith(".ts")) throw notBuilt(source.binPath);
  const real = realpathOrNull(source.binPath);
  if (!real || path.basename(real) !== `${NAME}.js` || path.basename(path.dirname(real)) !== "dist") {
    throw notBuilt(source.binPath);
  }
  const onPath = whichOnPath(NAME, source.pathEnv);
  if (onPath && realpathOrNull(onPath) === real) return [NAME];
  return [stableNode(source.execPath, source.pathEnv), real];
}

/** Quotes every part except the bare name, so the command survives spaces in paths. */
export function renderProgram(program: readonly string[]): string {
  if (program.length === 1 && program[0] === NAME) return NAME;
  return program.map((part) => `"${part.replace(/["\\$`]/g, "\\$&")}"`).join(" ");
}

/** The command a hook or an installed skill runs, as one shell string. */
export function hookCommand(source: CommandSource): string {
  return renderProgram(resolveProgram(source));
}
