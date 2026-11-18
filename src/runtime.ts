/**
 * Production wiring: the real reader, writer, converter, stdin and URL opener behind a Context.
 * Only the core converter is a dynamic import (it is the heavy chunk); the rest are small and
 * load their own Node built-ins lazily.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePaths } from "./config/paths.js";
import { createContext, type Context, type ContextOverrides } from "./context.js";
import { axiError } from "./errors.js";
import { connectWriter, probeHelper } from "./helper/notes-writer.js";
import { PROBE_TIMEOUT_MS } from "./helper/rpc-client.js";
import { openReader } from "./store/readonly-db.js";

export function createRuntimeContext(overrides: ContextOverrides = {}): Context {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? env.HOME ?? os.homedir();
  const uid = overrides.uid ?? os.userInfo().uid;
  return createContext({
    env,
    home,
    uid,
    paths: () => resolvePaths({ env, home, uid }),
    openReader,
    connectWriter: (paths, userId) => connectWriter(paths.socket, paths.runtimeDir, userId),
    loadConverter: async () => (await import("./markdown/convert.js")).converter,
    probeHelper: (paths, userId) => probeHelper(paths.socket, paths.runtimeDir, userId, PROBE_TIMEOUT_MS),
    readStdin,
    openUrl: (url) => openUrl(url, env),
    findApp: () => findApp(env, home),
    openApp: (appPath) => openWith(appPath, env, "could not start Overnote.app"),
    ...overrides,
  });
}

/** Reads all of stdin. Only called for an explicit `--content -`, so it can never hang a hook. */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The installed Overnote.app: OVERNOTE_APP_PATH when set (test/setup.ts points it nowhere, so no
 * test finds the real app), else /Applications, else ~/Applications; null when none exists.
 */
export function findApp(env: Readonly<Record<string, string | undefined>>, home: string): string | null {
  const candidates =
    env.OVERNOTE_APP_PATH !== undefined
      ? [env.OVERNOTE_APP_PATH]
      : ["/Applications/Overnote.app", path.join(home, "Applications", "Overnote.app")];
  return candidates.find((candidate) => candidate !== "" && existsSync(candidate)) ?? null;
}

/**
 * Runs `/usr/bin/open <target>`, no shell. `OVERNOTE_AXI_OPEN_CMD` (honored only when set)
 * replaces the opener with an absolute path to another program; test/setup.ts points it at a
 * recorder, so no test can ever launch the real Overnote against the real notes database.
 */
function openWith(target: string, env: Readonly<Record<string, string | undefined>>, failure: string): Promise<void> {
  const opener = env.OVERNOTE_AXI_OPEN_CMD || "/usr/bin/open";
  return new Promise((resolve, reject) => {
    const child = spawn(opener, [target], { stdio: "ignore" });
    child.once("error", () => reject(axiError(failure, "IO_ERROR")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(axiError(failure, "IO_ERROR"))));
  });
}

/** Opens a URL (the Raycast deeplinks) with `/usr/bin/open`. */
export function openUrl(url: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  return openWith(url, env, "could not open Overnote (is Raycast installed?)");
}
