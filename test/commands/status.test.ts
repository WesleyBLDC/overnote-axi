import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORE_REVISION } from "../../src/build-info.js";
import { stoppedReason } from "../../src/commands/status.js";
import type { OvernotePaths, SystemStatus } from "../../src/domain/types.js";
import { axiError } from "../../src/errors.js";
import { isoDate } from "../../src/output/render.js";
import { VERSION } from "../../src/version.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { assertIsolated } from "../fixtures/guard.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function status(fake: FakeContext) {
  return runCli(["status"], fake.context);
}

const BUILD = ["build:", `  version: ${VERSION}`, `  core: ${CORE_REVISION}`];
const DATABASE = "/tmp/overnote-axi-fake/support/notes.sqlite";
const SOCKET = "/tmp/overnote-axi-fake/run/helper.sock";

describe("status", () => {
  it("reports a running helper, the database, the socket, backups and the build", async () => {
    const fake = fakeContext();
    const { store, writer } = fake.fakes;
    store.add({ body: "One" });
    store.add({ body: "Two", deletedAt: 1 });
    const latest = 1_792_000_000_000;
    writer.status = async (): Promise<SystemStatus> => ({
      version: "0.3.0",
      pid: 4242,
      schemaVersion: 1,
      noteCount: 1,
      backupDir: "/tmp/overnote-axi-fake/backups",
      backupCount: 10,
      latestBackup: { path: "/b/x", name: "x", createdAt: latest, version: "0.3.0", reason: "daily", sizeBytes: 1 },
      restoreAvailable: false,
    });
    const { code, out } = await status(fake);
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        "helper:",
        "  state: running",
        "  version: 0.3.0",
        "  pid: 4242",
        "database:",
        `  path: ${DATABASE}`,
        "  schema: 1",
        "  notes: 1 live",
        "  trash: 1",
        `socket: ${SOCKET}`,
        "backups:",
        "  count: 10",
        `  latest: ${isoDate(latest)}`,
        ...BUILD,
      ),
    );
  });

  it("says when no backup exists yet and when the helper offers a restore", async () => {
    const fake = fakeContext();
    const base = await fake.fakes.writer.status();
    fake.fakes.writer.status = async () => ({ ...base, restoreAvailable: true });
    const { out } = await status(fake);
    expect(out).toContain(
      "backups:\n  count: 0\n  latest: none\n  restore: available (the helper started without a database; restore it in Overnote)\n",
    );
  });

  it("reports a stopped helper with the reason and the open hint, and leaves out backups", async () => {
    const fake = fakeContext();
    fake.fakes.store.helperRunning = false;
    const { code, out } = await status(fake);
    expect(code).toBe(0);
    expect(out).toContain("helper:\n  state: stopped\n  reason: no runtime dir (Overnote is not running)\n");
    expect(out).not.toContain("backups:");
    expect(out.endsWith("help[1]:\n  overnote-axi open\n")).toBe(true);
  });

  it("reports a helper that does not answer", async () => {
    const fake = fakeContext({
      connectWriter: async () => {
        throw axiError("Overnote did not answer system.ping in time; retry once", "HELPER_TIMEOUT", ["overnote-axi status"]);
      },
    });
    const { code, out } = await status(fake);
    expect(code).toBe(0);
    expect(out).toContain("helper:\n  state: not answering\n");
    expect(out.endsWith("help[1]:\n  overnote-axi open\n")).toBe(true);
  });

  it("reports any other helper error with its code", async () => {
    const fake = fakeContext();
    fake.fakes.store.failNext("status", axiError("Overnote could not complete system.status", "HELPER_ERROR", ["overnote-axi status"]));
    const { code, out } = await status(fake);
    expect(code).toBe(0);
    expect(out).toContain("  state: error\n  error: Overnote could not complete system.status\n  code: HELPER_ERROR\n");
    expect(out).not.toContain("  overnote-axi status");
  });

  it("reports a missing database with the hints that fix it", async () => {
    const fake = fakeContext({ openReader: () => null });
    const { code, out } = await status(fake);
    expect(code).toBe(0);
    expect(out).toContain(`database:\n  path: ${DATABASE}\n  state: missing\n`);
    expect(out).toContain(
      "help[2]:\n  overnote-axi open\n  Or point OVERNOTE_SUPPORT_DIR at the folder that holds notes.sqlite\n",
    );
  });

  it("reports an unreadable database with its details", async () => {
    const fake = fakeContext({
      openReader: () => {
        throw axiError("The notes database uses schema 9, which this overnote-axi does not support", "DATABASE_ERROR", [
          "Update overnote-axi (npm install -g . in its repository), then retry",
        ], { schema: 9, supported: "1" });
      },
    });
    const { code, out } = await status(fake);
    expect(code).toBe(0);
    expect(out).toContain(
      [
        "database:",
        `  path: ${DATABASE}`,
        "  state: unreadable",
        '  error: "The notes database uses schema 9, which this overnote-axi does not support"',
        "  code: DATABASE_ERROR",
        "  schema: 9",
        '  supported: "1"',
      ].join("\n"),
    );
    expect(out.endsWith("help[1]:\n  Update overnote-axi (npm install -g . in its repository), then retry\n")).toBe(true);
  });

  it("collapses the home directory in paths", async () => {
    const home = process.env.HOME!;
    const fake = fakeContext({
      paths: () => ({
        supportDir: `${home}/support`,
        database: `${home}/support/notes.sqlite`,
        runtimeDir: `${home}/run`,
        socket: `${home}/run/helper.sock`,
      }),
    });
    const { out } = await status(fake);
    expect(out).toContain("  path: ~/support/notes.sqlite\n");
    expect(out).toContain("socket: ~/run/helper.sock\n");
  });
});

describe("stoppedReason", () => {
  let root: string;
  let paths: OvernotePaths;
  const uid = os.userInfo().uid;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-status-"));
    assertIsolated(root, "status test dir");
    const runtimeDir = path.join(root, "run");
    paths = { supportDir: root, database: path.join(root, "notes.sqlite"), runtimeDir, socket: path.join(runtimeDir, "helper.sock") };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names each check that failed, in the writer's order", () => {
    expect(stoppedReason(paths, uid)).toBe("no runtime dir (Overnote is not running)");
    mkdirSync(paths.runtimeDir, { mode: 0o755 });
    chmodSync(paths.runtimeDir, 0o755);
    expect(stoppedReason(paths, uid)).toBe("runtime dir refused (not a private directory owned by you)");
    chmodSync(paths.runtimeDir, 0o700);
    expect(stoppedReason(paths, uid)).toBe("no socket (Overnote is not running)");
    writeFileSync(paths.socket, "not a socket");
    expect(stoppedReason(paths, uid)).toBe("socket refused (not a socket owned by you)");
  });
});
