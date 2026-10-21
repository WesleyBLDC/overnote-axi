/**
 * The built binary without a helper (docs/DESIGN.md section 11, "Built binary"): version and
 * help, usage and data errors with their exit codes, empty states, a missing database, a stopped
 * helper, a socket that never answers, output piped into a reader that closes early, and the
 * session hook payload. Reads use a fixture database in a temp support dir; nothing here starts
 * Overnote or touches the real home.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROBE_TIMEOUT_MS } from "../../src/helper/rpc-client.js";
import { COMMANDS } from "../../src/registry.js";
import { VERSION } from "../../src/version.js";
import { assertIsolated } from "../fixtures/guard.js";
import { createNotesDb, type NotesDbFixture } from "../fixtures/notes-db.js";
import { buildBinary, nodeFloor, outputLines, runBinary, runIntoHead, type BuiltBinary } from "./binary.js";

let binary: BuiltBinary;

beforeAll(() => {
  binary = buildBinary();
});

afterAll(() => {
  binary?.cleanup();
});

describe("version and help", () => {
  it.each(["--version", "-v", "-V"])("prints the version for %s with nothing on stderr", async (flag) => {
    const result = await runBinary(binary, [flag]);
    expect(result).toMatchObject({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it("prints the top-level help with every command", async () => {
    const result = await runBinary(binary, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: overnote-axi [command] [args] [flags]\n");
    expect(result.stdout).toContain(`commands[${COMMANDS.length}]:\n`);
    for (const entry of COMMANDS) expect(result.stdout).toContain(`  ${entry.name} `);
  });

  it.each(COMMANDS.map((entry) => entry.name))("prints help for %s from its own chunk", async (name) => {
    const result = await runBinary(binary, [name, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(new RegExp(`^usage: overnote-axi ${name}\\b`));
    expect(result.stdout).toMatch(/\nflags\[\d+\]:\n[\s\S]*--help {2,}Show this help\n/);
    expect(result.stdout).toMatch(/\nexamples\[\d+\]:\n {2}overnote-axi/);
  });
});

describe("usage errors exit 2 and name a fix", () => {
  const cases: ReadonlyArray<{ argv: string[]; error: string; help: string }> = [
    { argv: ["lsit"], error: "error: unknown command lsit", help: "  overnote-axi --help" },
    { argv: ["list", "--bogus"], error: "error: unknown flag --bogus for list", help: "  overnote-axi list [flags]" },
    { argv: ["list", "--limit", "abc"], error: "error: flag --limit must be a whole number (got abc)", help: "  overnote-axi list --help" },
    { argv: ["home", "--limit", "51"], error: "error: flag --limit must be at most 50 (got 51)", help: "  overnote-axi home --help" },
    { argv: ["read", "x", "--format", "html"], error: "error: flag --format does not accept html", help: "  overnote-axi read --help" },
    { argv: ["read"], error: "error: read requires <note>", help: "  overnote-axi read <note>... [flags]" },
    { argv: ["search", " "], error: "error: search needs a query that is not blank", help: '  overnote-axi search "<text>"' },
    { argv: ["create"], error: "error:", help: '  overnote-axi create --title "<text>"' },
    { argv: ["--limit", "3"], error: "error: flags go after the command (got --limit first)", help: "  overnote-axi home --limit 3" },
    { argv: ["--", "list"], error: "error: flags go after the command (got -- first)", help: "  overnote-axi list" },
    { argv: ["--help", "read"], error: "error: flags go after the command (got --help first)", help: "  overnote-axi read --help" },
  ];

  it.each(cases)("$argv", async ({ argv, error, help }) => {
    const result = await runBinary(binary, argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith(error)).toBe(true);
    expect(result.stdout).toContain("\ncode: VALIDATION_ERROR\n");
    expect(result.stdout).toMatch(/\nhelp\[\d+\]:\n/);
    expect(outputLines(result.stdout)).toContain(help);
  });
});

describe("without a notes database", () => {
  it("degrades the home view to one line and exits 0", async () => {
    const result = await runBinary(binary, ["home", "--limit", "3", "--pinned-limit", "3"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("\novernote: no notes database yet\nhelp[1]:\n  overnote-axi open\n");
  });

  it("fails reads with DATABASE_NOT_FOUND and exit 1", async () => {
    for (const argv of [["list"], ["search", "x"], ["read", "current"], ["links", "current"], ["trash"]]) {
      const result = await runBinary(binary, argv);
      expect(result.code, argv.join(" ")).toBe(1);
      expect(result.stdout).toContain("code: DATABASE_NOT_FOUND\n");
      expect(result.stderr).toBe("");
    }
  });

  it("still reports status with exit 0", async () => {
    const result = await runBinary(binary, ["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("helper:\n  state: stopped\n");
    expect(result.stdout).toContain("  state: missing\n");
  });

  it("opens Overnote without a database through the test opener", async () => {
    const result = await runBinary(binary, ["open"]);
    expect(result).toMatchObject({ code: 0, stdout: "opened: Overnote\n", stderr: "" });
  });
});

describe("an empty database", () => {
  let db: NotesDbFixture;

  beforeAll(() => {
    db = createNotesDb();
  });

  afterAll(() => db?.cleanup());

  it.each([
    [["list"], "notes: 0 live notes\nhelp[1]:\n  overnote-axi create --content \"<markdown>\"\n"],
    [["list", "--pinned"], "notes: 0 pinned notes\n"],
    [["search", "milk"], "hits: 0 notes match 'milk'\n"],
    [["trash"], "trash: 0 notes in Recently Deleted\n"],
  ])("%j states the zero and exits 0", async (argv, expected) => {
    const result = await runBinary(binary, argv, { env: db.env() });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.startsWith(expected)).toBe(true);
  });

  it("shows only the open and create hints on home while the helper is stopped", async () => {
    const result = await runBinary(binary, [], { env: db.env() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  notes: 0 live\n");
    expect(result.stdout.endsWith('help[2]:\n  overnote-axi open\n  overnote-axi create --content "<markdown>"\n')).toBe(true);
  });

  it("fails a reference with NOTE_NOT_FOUND and exit 1", async () => {
    const result = await runBinary(binary, ["read", "current"], { env: db.env() });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("code: NOTE_NOT_FOUND\n");
  });
});

describe("with notes and no helper", () => {
  let db: NotesDbFixture;
  let bigId: string;

  beforeAll(() => {
    db = createNotesDb();
    for (let i = 1; i <= 9; i += 1) db.add({ body: `Pinned ${i}\nbody of pin ${i}`, pinned: i * 1000 });
    for (let i = 1; i <= 600; i += 1) db.add({ body: `Note ${i}\n${"words for the preview column ".repeat(5)}` });
    bigId = db.add({ body: `Big\n${"a long paragraph of text ".repeat(20_000)}` }).id;
    db.setCurrent(bigId);
  });

  afterAll(() => db?.cleanup());

  it("fails a write with HELPER_NOT_RUNNING and exit 1, and keeps reads working", async () => {
    const write = await runBinary(binary, ["pin", "current"], { env: db.env() });
    expect(write.code).toBe(1);
    expect(write.stdout).toContain("code: HELPER_NOT_RUNNING\nhelp[1]:\n  overnote-axi open\n");
    const read = await runBinary(binary, ["read", "current", "--meta"], { env: db.env() });
    expect(read.code).toBe(0);
    expect(read.stdout).toContain(`  id: ${bigId}\n  title: Big\n`);
  });

  it("fails an ambiguous fragment with AMBIGUOUS_NOTE and exit 1", async () => {
    const result = await runBinary(binary, ["read", "01JAB00000"], { env: db.env() });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("code: AMBIGUOUS_NOTE\ncandidates[5]{id,title,state}:\n");
  });

  it("exits 0 with nothing on stderr when the reader closes early", () => {
    const list = runIntoHead(binary, ["list", "--limit", "500", "--fields", "id,title,preview"], 64, db.env());
    expect(list).toMatchObject({ code: 0, stderr: "" });
    expect(list.head).toHaveLength(64);
    expect(list.head.startsWith("count: 500 of 610 live notes\nnotes[500]{id,title,preview}:\n")).toBe(true);
    const read = runIntoHead(binary, ["read", bigId, "--full"], 16, db.env());
    expect(read).toMatchObject({ code: 0, stderr: "", head: "note:\n  id: 01JA" });
  });

  it("keeps the session hook payload within 24 lines", async () => {
    const result = await runBinary(binary, ["home", "--limit", "3", "--pinned-limit", "3"], { env: db.env() });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const lines = outputLines(result.stdout);
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(lines).toContain("pinned[3]{id,title,updated}:");
    expect(lines).toContain("recent[3]{id,title,updated}:");
    expect(lines).toContain("  overnote-axi list --pinned (all 9 pinned notes)");
    expect(lines).toContain("  helper: stopped (reads work; writes need overnote-axi open)");
  });
});

describe("a helper socket that accepts and never answers", () => {
  let db: NotesDbFixture;
  let root: string;
  let server: net.Server;
  let runtimeDir: string;

  beforeAll(async () => {
    db = createNotesDb();
    db.add({ body: "Standup" });
    // A short real path: a Unix socket path must stay under 104 bytes on macOS.
    root = realpathSync(mkdtempSync("/tmp/onx-hang-"));
    runtimeDir = path.join(root, "run");
    assertIsolated(runtimeDir, "hanging runtime dir");
    mkdirSync(runtimeDir, { mode: 0o700 });
    chmodSync(runtimeDir, 0o700);
    server = net.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(path.join(runtimeDir, "helper.sock"), resolve));
  });

  afterAll(async () => {
    // The CLI processes have exited, so their connections are closed; do not wait on close().
    server?.close();
    rmSync(root, { recursive: true, force: true });
    db?.cleanup();
  });

  it("still prints home within floor + 600 ms and says the helper is not answering", async () => {
    const env = { ...db.env(), OVERNOTE_RUNTIME_DIR: runtimeDir };
    // The floor is the fastest of seven runs, as every other budget measures it.
    const floor = nodeFloor();
    const result = await runBinary(binary, ["home", "--limit", "3", "--pinned-limit", "3"], { env });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("  helper: not answering (overnote-axi status)\n");
    expect(result.ms).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
    expect(result.ms).toBeLessThan(floor + 600);
  });

  it("refuses a runtime dir others can read with HELPER_NOT_RUNNING and points at status", async () => {
    const env = { ...db.env(), OVERNOTE_RUNTIME_DIR: runtimeDir };
    chmodSync(runtimeDir, 0o755);
    try {
      const write = await runBinary(binary, ["pin", "current"], { env });
      expect(write).toMatchObject({ code: 1, stderr: "" });
      expect(write.stdout).toContain("code: HELPER_NOT_RUNNING\nhelp[1]:\n  overnote-axi status\n");
      const status = await runBinary(binary, ["status"], { env });
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("  reason: runtime dir refused (not a private directory owned by you)\n");
      // The session hook payload gives the same advice as the write error.
      const home = await runBinary(binary, ["home", "--limit", "3", "--pinned-limit", "3"], { env });
      expect(home).toMatchObject({ code: 0, stderr: "" });
      expect(home.stdout).toContain(
        "  helper: refused (its runtime dir or socket is not private to you; overnote-axi status says why)\n",
      );
      expect(home.stdout).toContain("help[4]:\n  overnote-axi status\n");
      expect(home.stdout).not.toContain("overnote-axi open");
    } finally {
      chmodSync(runtimeDir, 0o700);
    }
  });

  it("times out a write with HELPER_TIMEOUT and exit 1", async () => {
    const result = await runBinary(binary, ["pin", "current"], { env: { ...db.env(), OVERNOTE_RUNTIME_DIR: runtimeDir } });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("code: HELPER_TIMEOUT\n");
    expect(result.stderr).toBe("");
  });
});
