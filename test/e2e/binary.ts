/**
 * Harness for the built binary tests (docs/DESIGN.md section 11, "Built binary"): builds a
 * private copy of the bundle with `scripts/build.mjs --outdir`, so a concurrent `npm run build`
 * can never swap `dist/` under a running test, and spawns it as a real process.
 *
 * Every spawned CLI inherits the isolated environment of test/setup.ts (temp Overnote dirs, temp
 * HOME, XDG_CONFIG_HOME and CODEX_HOME, OVERNOTE_AXI_OPEN_CMD=/usr/bin/true); a test may only
 * add paths on top of it, and every path it adds passes assertIsolated() first.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertIsolated } from "../fixtures/guard.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OPEN_CMD = "/usr/bin/true";
/** Variables that name a location; each one a test passes must be isolated. */
const PATH_VARIABLES = [
  "OVERNOTE_SUPPORT_DIR",
  "OVERNOTE_RUNTIME_DIR",
  "OVERNOTE_BACKUP_DIR",
  "HOME",
  "XDG_CONFIG_HOME",
  "CODEX_HOME",
] as const;

export interface BuiltBinary {
  /** The private `<tmp>/dist/overnote-axi.js`. */
  readonly script: string;
  /** Removes the private build. */
  cleanup(): void;
}

/** Builds the bundle into a fresh temp `dist/` (about 100 ms) and returns its entry. */
export function buildBinary(): BuiltBinary {
  const root = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-e2e-"));
  const outdir = path.join(root, "dist");
  assertIsolated(outdir, "e2e build dir");
  execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build.mjs"), "--outdir", outdir], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return {
    script: path.join(outdir, "overnote-axi.js"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The environment of one CLI process: test/setup.ts's isolation plus the test's own paths. */
export function isolatedEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  for (const name of PATH_VARIABLES) {
    const value = overrides[name];
    if (value !== undefined) assertIsolated(value, name);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, OVERNOTE_AXI_OPEN_CMD: OPEN_CMD };
  // Diagnostics would go to stderr, which these tests require to stay empty.
  delete env.OVERNOTE_AXI_DEBUG;
  for (const name of PATH_VARIABLES) assertIsolated(env[name] ?? "", name);
  return env;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Wall time from spawn to exit, in milliseconds. */
  readonly ms: number;
}

export interface RunOptions {
  env?: Readonly<Record<string, string>>;
  /** Written to stdin, then stdin is closed; without it stdin is closed at once. */
  input?: string;
}

/** Runs the built CLI once, asynchronously (so a fake socket in this process can still answer). */
export function runBinary(binary: BuiltBinary, argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const child = spawn(process.execPath, [binary.script, ...argv], {
    env: isolatedEnv(options.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.end(options.input ?? "");
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
  });
}

/**
 * Runs `<cli> <argv> | head -c <bytes>` and reports the CLI's own exit status and stderr, the way
 * an agent piping into `head` sees them.
 */
export function runIntoHead(
  binary: BuiltBinary,
  argv: readonly string[],
  bytes: number,
  env: Readonly<Record<string, string>> = {},
): { code: number; stderr: string; head: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-pipe-"));
  const errFile = path.join(root, "stderr");
  try {
    // $1 is node, $2 the script, $3 the stderr file, $4 the byte count, the rest the CLI argv.
    const script = 'node="$1" cli="$2" err="$3" bytes="$4"; shift 4; "$node" "$cli" "$@" 2>"$err" | head -c "$bytes"; exit "${PIPESTATUS[0]}"';
    const result = spawnSync("/bin/bash", ["-c", script, "bash", process.execPath, binary.script, errFile, String(bytes), ...argv], {
      env: isolatedEnv(env),
      encoding: "utf8",
    });
    return { code: result.status ?? -1, stderr: readFileSync(errFile, "utf8"), head: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Wall time of one synchronous run of `node <args>`, in milliseconds. */
export function timeNode(args: readonly string[], env: NodeJS.ProcessEnv): { ms: number; code: number | null } {
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { env, stdio: ["ignore", "ignore", "ignore"] });
  return { ms: performance.now() - started, code: result.status };
}

/** Runs per timing budget, for the CLI and for the `node -e 0` floor alike (docs/DESIGN.md section 10). */
export const TIMING_RUNS = 7;

/** The `node -e 0` floor: the fastest of TIMING_RUNS runs. */
export function nodeFloor(): number {
  return fastest(TIMING_RUNS, () => timeNode(["-e", "0"], process.env).ms);
}

/**
 * The fastest of `runs` timings. The minimum is the stable statistic for a startup budget: noise
 * from other test workers only ever adds time, so it is the best estimate of the real cost.
 */
export function fastest(runs: number, measure: (run: number) => number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) best = Math.min(best, measure(run));
  return best;
}

/** Output lines without the trailing newline. */
export function outputLines(stdout: string): string[] {
  return stdout.replace(/\n$/, "").split("\n");
}
