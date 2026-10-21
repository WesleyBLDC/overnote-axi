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
import { connectWriter } from "./helper/notes-writer.js";
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
    readStdin,
    openUrl,
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

export function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    child.once("error", () => reject(axiError("Could not open Overnote", "IO_ERROR")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(axiError("Could not open Overnote (is Raycast installed?)", "IO_ERROR")),
    );
  });
}
