/**
 * Production wiring: the real reader, writer, converter, stdin and URL opener behind a Context.
 * Only the core converter is a dynamic import (it is the heavy chunk); the rest are small and
 * load their own Node built-ins lazily.
 */
import { spawn } from "node:child_process";
import os from "node:os";

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
 * Opens a URL with `/usr/bin/open`, no shell. `OVERNOTE_AXI_OPEN_CMD` (honored only when set)
 * replaces the opener with an absolute path to another program; test/setup.ts points it at a
 * recorder, so no test can ever launch the real Overnote against the real notes database.
 */
export function openUrl(url: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const opener = env.OVERNOTE_AXI_OPEN_CMD || "/usr/bin/open";
  return new Promise((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: "ignore" });
    child.once("error", () => reject(axiError("could not open Overnote", "IO_ERROR")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(axiError("could not open Overnote (is Raycast installed?)", "IO_ERROR")),
    );
  });
}
