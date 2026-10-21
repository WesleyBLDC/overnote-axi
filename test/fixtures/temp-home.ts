/**
 * A fresh, empty home for the integrations tests (setup hooks and setup skill), plus a stand-in
 * for the built CLI at `<root>/pkg/dist/overnote-axi.js`, so `resolveProgram()` accepts it.
 * Every path goes through assertIsolated(), so a test can never reach real agent config.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertIsolated } from "./guard.js";

export interface TempHome {
  root: string;
  home: string;
  codexHome: string;
  xdgConfigHome: string;
  /** The stand-in `dist/overnote-axi.js`. */
  binPath: string;
  /** A directory that is on no PATH until a test links the bin into it with linkOnPath(). */
  binDir: string;
  /** The environment a Context built for this home uses. */
  env: Record<string, string>;
  /** Puts an executable `overnote-axi` symlink to `target` (default binPath) in binDir. */
  linkOnPath(target?: string): string;
  remove(): void;
}

export function tempHome(): TempHome {
  const root = mkdtempSync(path.join(os.tmpdir(), "onx-home-"));
  assertIsolated(root, "temp home");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const xdgConfigHome = path.join(home, ".config");
  const binPath = path.join(root, "pkg", "dist", "overnote-axi.js");
  const binDir = path.join(root, "bin");
  mkdirSync(home);
  mkdirSync(binDir);
  mkdirSync(path.dirname(binPath), { recursive: true });
  writeFileSync(binPath, "#!/usr/bin/env node\n");
  chmodSync(binPath, 0o755);
  for (const dir of [home, codexHome, xdgConfigHome, binPath, binDir]) assertIsolated(dir, "temp home path");

  return {
    root,
    home,
    codexHome,
    xdgConfigHome,
    binPath,
    binDir,
    env: { HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome, PATH: binDir },
    linkOnPath(target = binPath) {
      const link = path.join(binDir, "overnote-axi");
      rmSync(link, { force: true });
      symlinkSync(target, link);
      return link;
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
