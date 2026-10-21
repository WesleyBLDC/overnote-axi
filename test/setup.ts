/**
 * Runs before every test file. Points every location the CLI could touch at a fresh temp folder,
 * so a test that forgets its own paths fails with DATABASE_NOT_FOUND or HELPER_NOT_RUNNING
 * instead of ever reaching Wesley's real notes or agent configuration:
 *
 * - OVERNOTE_SUPPORT_DIR, OVERNOTE_RUNTIME_DIR, OVERNOTE_BACKUP_DIR: nonexistent temp paths;
 * - HOME, XDG_CONFIG_HOME, CODEX_HOME: an empty temp home, so `setup` and `setup skill` can
 *   only write ~/.claude, ~/.codex and ~/.config/opencode inside it;
 * - OVERNOTE_AXI_OPEN_CMD: /usr/bin/true, so a spawned CLI never runs the real /usr/bin/open
 *   (which would launch the real Overnote against the real database).
 *
 * Spawned processes (test/e2e) inherit this environment. Tests that need data create their own
 * temp dirs (test/fixtures/) and pass them through assertIsolated().
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertIsolated } from "./fixtures/guard.js";

const root = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-test-"));
const nowhere = path.join(root, "nowhere");
const home = mkdtempSync(path.join(root, "home-"));

process.env.OVERNOTE_SUPPORT_DIR = path.join(nowhere, "support");
process.env.OVERNOTE_RUNTIME_DIR = path.join(nowhere, "run");
process.env.OVERNOTE_BACKUP_DIR = path.join(nowhere, "backups");
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.OVERNOTE_AXI_OPEN_CMD = "/usr/bin/true";

for (const name of ["OVERNOTE_SUPPORT_DIR", "OVERNOTE_RUNTIME_DIR", "OVERNOTE_BACKUP_DIR", "HOME", "XDG_CONFIG_HOME", "CODEX_HOME"]) {
  assertIsolated(process.env[name]!, name);
}
if (os.homedir() !== home) throw new Error("Test isolation: os.homedir() does not follow HOME");
