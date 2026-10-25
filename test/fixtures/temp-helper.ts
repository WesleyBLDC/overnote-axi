/**
 * Starts the real OvernoteHelper headless against throwaway directories, for integration tests
 * (docs/DESIGN.md section 11). Everything lives in one fresh short `/tmp/onx-*` dir (a Unix
 * socket path must stay under 104 bytes on macOS): the support dir with its `notes.sqlite`, the
 * runtime dir (mode 0700, as the CLI insists) with the socket and pid file, an empty editor dir,
 * and the backups dir the helper reads from `OVERNOTE_BACKUP_DIR`. Every one of them passes
 * assertIsolated() before the helper starts, so it can never open the real database or listen
 * beside the real helper.
 *
 * The binary is `OVERNOTE_HELPER_BIN`, else `<overnote checkout>/helper/.build/release/OvernoteHelper`
 * through the `.overnote` link. When it is missing, `helperBinary()` returns null and suites
 * skip with `HELPER_MISSING`, instead of failing on a machine without a Swift build.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RpcClient, type MethodParams, type MethodResult, type SocketMethod } from "../../src/helper/rpc-client.js";
import { assertIsolated } from "./guard.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_HELPER_BIN = path.join(REPO_ROOT, ".overnote", "helper", ".build", "release", "OvernoteHelper");

/** How long the helper may take to answer its first ping (a cold start on a slow machine). */
const START_TIMEOUT_MS = 10_000;
/** How long a graceful `system.shutdown` may take before the fixture escalates to signals. */
const STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 25;

/** The binary the fixture runs, or null when it is not built (or not executable). */
export function helperBinary(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const candidate = env.OVERNOTE_HELPER_BIN?.trim() ? path.resolve(env.OVERNOTE_HELPER_BIN) : DEFAULT_HELPER_BIN;
  try {
    accessSync(candidate, constants.X_OK);
    return lstatSync(realpathSync(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** The schema version the helper reports with `--schema-version` (what its database gets). */
export function helperSchemaVersion(bin: string): number {
  const out = execFileSync(bin, ["--schema-version"], { encoding: "utf8", timeout: 5000 }).trim();
  const version = Number(out);
  if (!Number.isInteger(version)) throw new Error(`${bin} --schema-version printed ${JSON.stringify(out)}`);
  return version;
}

/** The skip message integration suites print when helperBinary() is null. */
export const HELPER_MISSING =
  "OvernoteHelper is not built: run `swift build -c release` in <overnote>/helper, or set OVERNOTE_HELPER_BIN";

export interface TempHelperOptions {
  /** Enables the helper's `test.*` socket methods (for example `test.events`). */
  testHooks?: boolean;
}

export interface TempHelper {
  readonly root: string;
  readonly supportDir: string;
  readonly database: string;
  readonly runtimeDir: string;
  readonly socket: string;
  readonly pidFile: string;
  readonly backupDir: string;
  readonly editorDir: string;
  /** The helper's process id while it runs. */
  readonly pid: number;
  /** Environment that points the CLI at this helper and its database. */
  env(): Record<string, string>;
  /** A direct RPC call, for arranging state and checking what the CLI wrote. */
  call<M extends SocketMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** Stops the helper (shutdown, then SIGTERM, then SIGKILL) and leaves the files in place. */
  stop(): Promise<void>;
  /** stop(), then removes the whole temp dir. Safe to call more than once. */
  cleanup(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child exits, false after `ms`. */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function makePrivateDir(dir: string): void {
  mkdirSync(dir, { mode: 0o700 });
  // mkdir applies the umask; set the mode explicitly and check it, because the CLI refuses a
  // runtime dir open to group or other users.
  chmodSync(dir, 0o700);
  const mode = lstatSync(dir).mode & 0o777;
  if (mode !== 0o700) throw new Error(`temp helper: ${dir} has mode ${mode.toString(8)}, expected 700`);
}

/**
 * Starts a fresh helper and waits until it answers `system.ping`. Throws when the binary is
 * missing (check helperBinary() first) or the helper exits or stays silent during startup.
 */
export async function startTempHelper(options: TempHelperOptions = {}): Promise<TempHelper> {
  const bin = helperBinary();
  if (bin === null) throw new Error(HELPER_MISSING);

  // realpath: /tmp is a symlink to /private/tmp on macOS, and the CLI lstats the real path.
  const root = realpathSync(mkdtempSync("/tmp/onx-"));
  const supportDir = path.join(root, "support");
  const runtimeDir = path.join(root, "run");
  const socket = path.join(runtimeDir, "helper.sock");
  const pidFile = path.join(runtimeDir, "helper.pid");
  const backupDir = path.join(root, "backups");
  const editorDir = path.join(root, "editor");
  const database = path.join(supportDir, "notes.sqlite");
  for (const [what, value] of Object.entries({ root, supportDir, runtimeDir, socket, pidFile, backupDir, editorDir })) {
    assertIsolated(value, `temp helper ${what}`);
  }
  makePrivateDir(runtimeDir);
  mkdirSync(editorDir);

  const args = [
    "--support-dir",
    supportDir,
    "--socket",
    socket,
    "--pid-file",
    pidFile,
    "--editor-dir",
    editorDir,
    "--headless",
    ...(options.testHooks ? ["--test-hooks"] : []),
  ];
  const child = spawn(bin, args, {
    env: {
      ...process.env,
      OVERNOTE_BACKUP_DIR: backupDir,
      OVERNOTE_SUPPORT_DIR: supportDir,
      OVERNOTE_RUNTIME_DIR: runtimeDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const spawnFailure = new Promise<Error>((resolve) => child.once("error", resolve));
  // "close" fires once the process exited and its stderr is fully read.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  const client = new RpcClient(socket, { connectTimeoutMs: 500 });
  let stopped = false;
  let removed = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (!exited(child)) {
      await client.call("system.shutdown", {}, 2000).catch(() => undefined);
      if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
        child.kill("SIGTERM");
        if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
          child.kill("SIGKILL");
          await waitForExit(child, STOP_TIMEOUT_MS);
        }
      }
    }
    client.close();
  };

  const helper: TempHelper = {
    root,
    supportDir,
    database,
    runtimeDir,
    socket,
    pidFile,
    backupDir,
    editorDir,
    pid: child.pid ?? 0,
    env: () => ({
      OVERNOTE_SUPPORT_DIR: supportDir,
      OVERNOTE_RUNTIME_DIR: runtimeDir,
      OVERNOTE_BACKUP_DIR: backupDir,
    }),
    call: (method, params) => client.call(method, params),
    stop,
    async cleanup() {
      await stop();
      if (removed) return;
      removed = true;
      rmSync(root, { recursive: true, force: true });
    },
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const failure = await Promise.race([spawnFailure, delay(0).then(() => null)]);
    if (failure || exited(child)) {
      await Promise.race([closed, delay(1000)]);
      await helper.cleanup();
      const reason = failure ? failure.message : `exit ${child.exitCode ?? child.signalCode}`;
      throw new Error(`temp helper in ${root} did not start (${reason}): ${stderr.trim()}`);
    }
    try {
      await client.call("system.ping", {}, 500);
      return helper;
    } catch {
      client.close();
    }
    if (Date.now() > deadline) {
      await helper.cleanup();
      throw new Error(`temp helper in ${root} did not answer within ${START_TIMEOUT_MS} ms: ${stderr.trim()}`);
    }
    await delay(POLL_MS);
  }
}
