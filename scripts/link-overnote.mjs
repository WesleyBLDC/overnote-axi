// Points the git-ignored `.overnote` symlink at the Overnote checkout, so tsc, vitest and esbuild
// all resolve @overnote/core from one place. Safe to run repeatedly.
import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";

import { overnoteDir, repoRoot } from "./overnote-dir.mjs";

const link = path.join(repoRoot, ".overnote");
const target = overnoteDir();

let current = null;
try {
  if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
  else throw new Error(`${link} exists and is not a symlink; remove it and run again.`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (current !== target) {
  if (current !== null) unlinkSync(link);
  symlinkSync(target, link, "dir");
}
