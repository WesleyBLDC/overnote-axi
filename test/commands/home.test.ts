import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { HelperProbe } from "../../src/domain/types.js";
import { axiError } from "../../src/errors.js";
import { DESCRIPTION } from "../../src/meta.js";
import { isoDate } from "../../src/output/render.js";
import { TESTED_SCHEMA_VERSION, updateHint } from "../../src/store/readonly-db.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { assertIsolated } from "../fixtures/guard.js";
import { lines, runCli } from "../fixtures/run-cli.js";

const HEADER = ["bin: /opt/overnote-axi/dist/overnote-axi.js", `description: "${DESCRIPTION}"`];
/** The fake bin path does not exist, so the update hint is the copied install form. */
const UPDATE_HINT = updateHint("/opt/overnote-axi/dist/overnote-axi.js");
const HINTS = [
  "help[3]:",
  "  overnote-axi read <id>",
  '  overnote-axi search "<text>"',
  '  overnote-axi create --content "<markdown>"',
];

function home(fake: FakeContext, ...argv: string[]) {
  return runCli(["home", ...argv], fake.context);
}

/** Three pinned notes (pin order differs from creation order) and three others. */
function seeded(): FakeContext {
  const fake = fakeContext();
  const { store } = fake.fakes;
  store.add({ body: "Groceries\nmilk", pinned: 2000 });
  const standup = store.add({ body: "Standup\n- [ ] demo", pinned: 1000 });
  store.add({ body: "Reading list", pinned: 3000 });
  store.add({ body: "Trip ideas" });
  store.add({ body: "Invoice draft" });
  store.add({ body: "Old draft", deletedAt: store.clock });
  store.currentNoteId = standup.id;
  return fake;
}

function day(fake: FakeContext, title: string): string {
  const note = [...fake.fakes.store.notes.values()].find((entry) => entry.title === title)!;
  return `${note.id},${title},${isoDate(note.updatedAt)}`;
}

describe("home", () => {
  it("runs by default with no arguments", async () => {
    const fake = seeded();
    const bare = await runCli([], fake.context);
    expect(bare.code).toBe(0);
    expect(bare.out).toBe((await home(seeded())).out);
  });

  it("prints helper state, counts, the current note, pinned and recent rows, and the home hints", async () => {
    const fake = seeded();
    const standup = [...fake.fakes.store.notes.values()].find((note) => note.title === "Standup")!;
    const { code, out } = await home(fake);
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        ...HEADER,
        "overnote:",
        "  helper: running v0.3.0",
        "  notes: 5 live",
        "  pinned: 3",
        "  trash: 1",
        `current: ${standup.id} Standup`,
        "pinned[3]{id,title,updated}:",
        `  ${day(fake, "Standup")}`,
        `  ${day(fake, "Groceries")}`,
        `  ${day(fake, "Reading list")}`,
        "recent[2]{id,title,updated}:",
        `  ${day(fake, "Invoice draft")}`,
        `  ${day(fake, "Trip ideas")}`,
        ...HINTS,
      ),
    );
  });

  it("caps pinned rows and points at list --pinned for the rest", async () => {
    const fake = seeded();
    const { out } = await home(fake, "--pinned-limit", "2", "--limit", "1");
    expect(out).toContain(`pinned[2]{id,title,updated}:\n  ${day(fake, "Standup")}\n  ${day(fake, "Groceries")}\n`);
    expect(out).toContain(`recent[1]{id,title,updated}:\n  ${day(fake, "Invoice draft")}\n`);
    expect(out.endsWith(lines(
      "help[5]:",
      "  overnote-axi read <id>",
      '  overnote-axi search "<text>"',
      '  overnote-axi create --content "<markdown>"',
      "  overnote-axi list --pinned (all 3 pinned notes)",
      "  overnote-axi list (all 5 live notes)",
    ))).toBe(true);
  });

  it("points at list with the total when recent rows are cut", async () => {
    const fake = seeded();
    const { out } = await home(fake, "--limit", "1");
    expect(out).toContain(`recent[1]{id,title,updated}:\n  ${day(fake, "Invoice draft")}\n`);
    expect(out).toContain("  overnote-axi list (all 5 live notes)\n");
    expect(out).not.toContain("--pinned (all");
    expect((await home(fake)).out).not.toContain("overnote-axi list (all");
  });

  it("leaves out row blocks whose limit is 0", async () => {
    const fake = seeded();
    const { out } = await home(fake, "--pinned-limit", "0", "--limit", "0");
    expect(out).not.toContain("pinned[");
    expect(out).not.toContain("recent[");
    expect(out).toContain("  overnote-axi list --pinned (all 3 pinned notes)\n");
    expect(out).toContain("  overnote-axi list (all 5 live notes)\n");
  });

  it("falls back to the newest live note when the current note is trashed or unset", async () => {
    const fake = seeded();
    const { store } = fake.fakes;
    const trashed = [...store.notes.values()].find((note) => note.title === "Old draft")!;
    store.currentNoteId = trashed.id;
    const newest = [...store.notes.values()].find((note) => note.title === "Invoice draft")!;
    expect((await home(fake)).out).toContain(`\ncurrent: ${newest.id} Invoice draft (newest; none open)\n`);
    store.currentNoteId = null;
    expect((await home(fake)).out).toContain(`\ncurrent: ${newest.id} Invoice draft (newest; none open)\n`);
  });

  it("states zero notes and offers only create", async () => {
    const fake = fakeContext();
    fake.fakes.store.add({ body: "Gone", deletedAt: 1 });
    const { code, out } = await home(fake);
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        ...HEADER,
        "overnote:",
        "  helper: running v0.3.0",
        "  notes: 0 live",
        "  pinned: 0",
        "  trash: 1",
        "help[1]:",
        '  overnote-axi create --content "<markdown>"',
      ),
    );
  });

  it("says there is no database yet and exits 0", async () => {
    const fake = fakeContext({ openReader: () => null });
    const { code, out } = await home(fake);
    expect(code).toBe(0);
    expect(out).toBe(lines(...HEADER, "overnote: no notes database yet", "help[1]:", "  overnote-axi open"));
  });

  it("reports an unreadable database without failing the session", async () => {
    const fake = fakeContext({
      openReader: () => {
        throw axiError("the notes database (schema 9) lacks columns this overnote-axi reads", "DATABASE_ERROR", [
          "overnote-axi status",
          UPDATE_HINT,
        ], { schema: 9, missing: "notes.text_fold" });
      },
    });
    const { code, out } = await home(fake);
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        ...HEADER,
        "overnote:",
        "  error: the notes database (schema 9) lacks columns this overnote-axi reads",
        "  code: DATABASE_ERROR",
        "  schema: 9",
        "  missing: notes.text_fold",
        "help[2]:",
        "  overnote-axi status",
        `  ${UPDATE_HINT}`,
      ),
    );
  });

  it("notes a schema newer than tested in one line and keeps reading", async () => {
    const fake = fakeContext();
    fake.fakes.reader.schema = TESTED_SCHEMA_VERSION + 1;
    fake.fakes.store.add({ body: "Note" });
    const { code, out } = await home(fake);
    expect(code).toBe(0);
    expect(out).toContain(
      `  trash: 0\n  schema: "${TESTED_SCHEMA_VERSION + 1}, newer than this overnote-axi was tested with (overnote-axi status)"\ncurrent: `,
    );
    const tested = fakeContext();
    tested.fakes.reader.schema = TESTED_SCHEMA_VERSION;
    expect((await home(tested)).out).not.toContain("schema");
  });

  it.each<[HelperProbe, string]>([
    [{ state: "stopped" }, "stopped (reads work; writes need overnote-axi open)"],
    [{ state: "not-answering" }, "not answering (overnote-axi status)"],
  ])("shows a helper that is %o", async (probe, line) => {
    const fake = fakeContext({ probeHelper: async () => probe });
    fake.fakes.store.add({ body: "Note" });
    const { code, out } = await home(fake);
    expect(code).toBe(0);
    expect(out).toContain(`  helper: ${line}\n`);
  });

  it("leads with overnote-axi open when the helper is stopped", async () => {
    const fake = fakeContext({ probeHelper: async () => ({ state: "stopped" }) });
    fake.fakes.store.add({ body: "Note" });
    const { out } = await home(fake);
    expect(out.endsWith(lines(
      "help[4]:",
      "  overnote-axi open",
      "  overnote-axi read <id>",
      '  overnote-axi search "<text>"',
      '  overnote-axi create --content "<markdown>"',
    ))).toBe(true);
  });

  it("says refused and hints status when the runtime dir is not private, as the writer does", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "onx-refused-"));
    assertIsolated(dir, "refused runtime dir");
    try {
      const runtimeDir = path.join(dir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o755 });
      chmodSync(runtimeDir, 0o755);
      const paths = { ...fakeContext().context.paths(), runtimeDir, socket: path.join(runtimeDir, "helper.sock") };
      const fake = fakeContext({ probeHelper: async () => ({ state: "stopped" }), paths: () => paths, uid: os.userInfo().uid });
      fake.fakes.store.add({ body: "Note" });
      const { code, out } = await home(fake);
      expect(code).toBe(0);
      expect(out).toContain("  helper: refused (its runtime dir or socket is not private to you; overnote-axi status says why)\n");
      expect(out).toContain("help[4]:\n  overnote-axi status\n");
      expect(out).not.toContain("overnote-axi open");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collapses the home directory in the bin path", async () => {
    const fake = fakeContext({ binPath: `${process.env.HOME}/.npm-global/bin/overnote-axi` });
    expect((await home(fake)).out.split("\n")[0]).toBe("bin: ~/.npm-global/bin/overnote-axi");
  });

  it("keeps the session hook payload within 24 lines on 9 pins and 20 other notes", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    for (let i = 1; i <= 9; i++) store.add({ body: `Pinned ${i}`, pinned: i * 1000 });
    for (let i = 1; i <= 20; i++) store.add({ body: `Other ${i}` });
    // A schema newer than tested adds its one line; the budget still holds.
    fake.fakes.reader.schema = TESTED_SCHEMA_VERSION + 1;
    const { code, out } = await home(fake, "--limit", "3", "--pinned-limit", "3");
    expect(code).toBe(0);
    expect(out).toContain("  schema: ");
    expect(out.trimEnd().split("\n").length).toBeLessThanOrEqual(24);
    expect(out).toContain("pinned[3]{id,title,updated}:");
    expect(out).toContain("recent[3]{id,title,updated}:");
  });

  it("rejects limits outside their range as usage errors", async () => {
    const fake = seeded();
    expect((await home(fake, "--pinned-limit", "10")).code).toBe(2);
    expect((await home(fake, "--limit", "51")).code).toBe(2);
  });
});
