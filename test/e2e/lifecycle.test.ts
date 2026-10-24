/**
 * Every command of the built binary against the real OvernoteHelper (test/fixtures/temp-helper.ts),
 * as an agent runs them: create, read, list, search, links, link, update, edit, pin, move, unpin,
 * duplicate, delete, trash, recover, permanent deletion, emptying the trash, status, open, and
 * setup in the temp home. Each step checks stdout, the exit code, and an empty stderr. The
 * helper runs headless in throwaway directories; `open` runs /usr/bin/true. Skips when the
 * helper binary is not built.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HELPER_MISSING, helperBinary, helperSchemaVersion, startTempHelper, type TempHelper } from "../fixtures/temp-helper.js";
import { buildBinary, runBinary, type BuiltBinary, type RunOptions, type RunResult } from "./binary.js";

const available = helperBinary() !== null;
const schema = available ? helperSchemaVersion(helperBinary()!) : 0;
const title = "the built binary against the real helper";

/** The first full id a block printed under `label`. */
function idAfter(out: string, label = "id"): string {
  const match = new RegExp(`\\n {2}${label}: ([0-9A-Z]{26})\\n`).exec(`\n${out}`);
  if (!match?.[1]) throw new Error(`no ${label} in output:\n${out}`);
  return match[1];
}

describe.skipIf(!available)(available ? title : `${title} (skipped: ${HELPER_MISSING})`, () => {
  let helper: TempHelper;
  let binary: BuiltBinary;

  async function cli(argv: string[], options: Omit<RunOptions, "env"> = {}): Promise<RunResult> {
    const result = await runBinary(binary, argv, { ...options, env: helper.env() });
    expect(result.stderr, argv.join(" ")).toBe("");
    return result;
  }

  async function ok(argv: string[], options: Omit<RunOptions, "env"> = {}): Promise<string> {
    const result = await cli(argv, options);
    expect(result.code, `${argv.join(" ")}\n${result.stdout}`).toBe(0);
    return result.stdout;
  }

  async function fails(argv: string[], exit: 1 | 2, code: string): Promise<string> {
    const result = await cli(argv);
    expect(result.code, `${argv.join(" ")}\n${result.stdout}`).toBe(exit);
    expect(result.stdout).toContain(`\ncode: ${code}\n`);
    return result.stdout;
  }

  beforeAll(async () => {
    binary = buildBinary();
    helper = await startTempHelper();
  });

  afterAll(async () => {
    await helper?.cleanup();
    binary?.cleanup();
  });

  it("starts with empty states and a running helper", async () => {
    const home = await ok([]);
    expect(home).toContain("overnote:\n  helper: running v");
    expect(home).toContain("  notes: 0 live\n");
    expect(await ok(["list"])).toBe('notes: 0 live notes\nhelp[1]:\n  overnote-axi create --content "<markdown>"\n');
    expect(await ok(["trash"])).toBe("trash: 0 notes in Recently Deleted\n");
    expect(await ok(["status"])).toMatch(/^helper:\n {2}state: running\n {2}version: \S+\n {2}pid: \d+\n/);
    await fails(["read", "current"], 1, "NOTE_NOT_FOUND");
  });

  it("creates, reads, lists, searches, links, and edits notes", async () => {
    const standup = idAfter(await ok(["create", "--title", "Standup", "--content", "- [ ] demo the CLI"]));
    const groceriesOut = await ok(["create", "--content", "-", "--pin"], { input: "Groceries\n\n- milk\n- eggs\n" });
    expect(groceriesOut).toContain("  pinned: 1\n");
    const groceries = idAfter(groceriesOut);

    const read = await ok(["read", standup]);
    expect(read).toContain(`note:\n  id: ${standup}\n  title: Standup\n  state: live\n`);
    expect(read).toContain("markdown:\n  # Standup\n\n  - [ ] demo the CLI\n");
    expect(await ok(["read", "title:groceries", "--format", "text"])).toContain("text:\n  Groceries\n\n  milk\n  eggs\n");

    const list = await ok(["list", "--fields", "id,title,pinned"]);
    expect(list).toBe(
      `count: 2 of 2 live notes\nnotes[2]{id,title,pinned}:\n  ${groceries},Groceries,1\n  ${standup},Standup,""\nhelp[1]:\n  overnote-axi read <id>\n`,
    );
    expect(await ok(["search", "milk"])).toContain(`hits[1]{id,title,match}:\n  ${groceries},Groceries,`);
    expect(await ok(["search", "nothing-like-this"])).toContain("hits: 0 notes match 'nothing-like-this'\n");

    const link = await ok(["link", groceries]);
    expect(link).toContain(`link:\n  id: ${groceries}\n  markdown: "[Groceries](raycast://extensions/wesleybldc/overnote/toggle-notes?context=`);
    expect(link.match(/raycast:/g)).toHaveLength(1);
    expect(await ok(["link", groceries, "--into", standup])).toContain(`linked:\n  id: ${groceries}\n  into: ${standup}\n  title: Standup\n`);
    expect(await ok(["link", groceries, "--into", standup])).toContain("(no-op; ");
    await fails(["link", standup, "--into", standup], 2, "VALIDATION_ERROR");
    expect(await ok(["links", groceries])).toContain(`backlinks[1]{id,title}:\n  ${standup},Standup\n`);
    expect(await ok(["links", standup])).toContain(`outgoing[1]{id,title}:\n  ${groceries},Groceries\n`);

    expect(await ok(["update", standup, "--content", "- [ ] call Sam"])).toContain("  mode: append\n");
    expect(await ok(["update", standup, "--content", "- [ ] call Sam"])).toContain("(no-op; ");
    await fails(["update", standup, "--replace", "--content", "x"], 2, "VALIDATION_ERROR");
    const stale = await fails(["update", standup, "--replace", "--content", "x", "--expected-updated-at", "1"], 1, "STALE_WRITE");
    expect(stale).toMatch(/\nupdatedAt: \d+\n/);

    await fails(["edit", standup, "--old", "not there", "--new", "x"], 1, "TEXT_NOT_FOUND");
    expect(await fails(["edit", standup, "--old", "[ ]", "--new", "[x]"], 1, "AMBIGUOUS_TEXT")).toContain("\nmatches: 2\n");
    expect(await ok(["edit", standup, "--old", "call Sam", "--new", "call Alex"])).toContain("  replaced: 1\n");
    expect(await ok(["edit", standup, "--old", "[ ]", "--new", "[x]", "--all"])).toContain("  replaced: 2\n");
    const markdown = await ok(["read", standup, "--full"]);
    expect(markdown).toContain("  - [x] demo the CLI\n");
    expect(markdown).toContain("  - [x] call Alex\n");

    const meta = await ok(["read", standup, "--meta"]);
    const updatedAt = /\n {2}updatedAt: (\d+)\n/.exec(meta)![1]!;
    const replaced = await ok(["update", standup, "--replace", "--content", "# Standup\n\nfresh start", "--expected-updated-at", updatedAt]);
    expect(replaced).toContain("  mode: replace\n");
    expect(await ok(["read", standup])).toContain("markdown:\n  # Standup\n\n  fresh start\n");
  });

  it("warns when it writes to the note open in Overnote", async () => {
    const out = await ok(["update", "current", "--content", "- [ ] one more"]);
    expect(out).toContain("warning: note is open in Overnote; unsaved edits there can win over this write\n");
  });

  it("pins, moves, unpins, and duplicates notes", async () => {
    const a = idAfter(await ok(["create", "--content", "Alpha", "--pin"]));
    const b = idAfter(await ok(["create", "--content", "Beta"]));
    expect(await ok(["pin", b])).toMatch(/^pinned: \S+ Beta \(position (\d) of \1\)\n$/);
    expect(await ok(["pin", b])).toContain("(no-op; already at position");
    expect(await ok(["move", b, "up"])).toContain("Beta (position 2 of 3)");
    expect(await ok(["move", b, "up", "--steps", "5"])).toContain("reached the top");
    expect(await ok(["move", a, "down"])).toContain("(no-op; already at the bottom as position 3 of 3)");
    expect(await ok(["move", a, "up", "--steps", "9"])).toContain("Alpha (position 1 of 3; reached the top after 2 of 9 steps)");
    expect(await ok(["move", a, "down", "--steps", "9"])).toContain("reached the bottom after 2 of 9 steps");
    await fails(["move", a, "sideways"], 2, "VALIDATION_ERROR");
    expect(await ok(["unpin", b])).toBe(`unpinned: ${b} Beta\n`);
    expect(await ok(["unpin", b])).toContain("(no-op; not pinned)");
    await fails(["move", b, "up"], 1, "NOT_PINNED");
    const copy = await ok(["duplicate", a, "--suffix", " copy"]);
    expect(copy).toContain(`duplicated:\n  id: `);
    expect(copy).toContain("  title: Alpha copy\n");
    expect(copy).toContain(`  from: ${a}\n`);
  });

  it("deletes, recovers, erases, and empties the trash", async () => {
    const doomed = idAfter(await ok(["create", "--content", "Doomed"]));
    const kept = idAfter(await ok(["create", "--content", "Kept"]));
    await ok(["create", "--content", "Elsewhere"]);
    expect(await ok(["delete", doomed])).toBe(
      `deleted: ${doomed} Doomed (in Recently Deleted)\nhelp[1]:\n  overnote-axi recover ${doomed}\n`,
    );
    expect(await ok(["delete", doomed])).toContain("(no-op; already in Recently Deleted)");
    expect(await ok(["read", doomed, "--meta"])).toContain("  state: trashed\n  deleted: ");
    await fails(["update", doomed, "--content", "x"], 1, "NOTE_TRASHED");
    await fails(["pin", doomed], 1, "NOTE_TRASHED");
    await fails(["open", doomed], 1, "NOTE_TRASHED");
    expect(await ok(["search", "doomed", "--trash"])).toContain(`  ${doomed},Doomed,title\n`);

    expect(await ok(["recover", doomed])).toContain(`recovered: ${doomed} Doomed\n`);
    expect(await ok(["recover", doomed])).toContain("(no-op; not in Recently Deleted)");

    await fails(["delete", doomed.slice(0, 12), "--permanent"], 2, "VALIDATION_ERROR");
    await fails(["delete", "current", "--permanent"], 2, "VALIDATION_ERROR");
    expect(await ok(["delete", doomed, "--permanent"])).toBe(`deleted: ${doomed} Doomed (erased permanently)\n`);
    expect(await ok(["delete", doomed, "--permanent"])).toBe(`deleted: ${doomed} (no-op; no note with this id exists)\n`);
    await fails(["read", doomed], 1, "NOTE_NOT_FOUND");

    await ok(["delete", kept]);
    const trash = await ok(["trash"]);
    expect(trash).toContain(`count: 1 of 1 note in Recently Deleted\ntrash[1]{id,title,deleted}:\n  ${kept},Kept,`);
    expect(trash).not.toContain("--permanent");
    await fails(["trash", "--empty"], 2, "VALIDATION_ERROR");
    expect(await fails(["trash", "--empty", "--permanent", "--expected-count", "4"], 1, "STALE_WRITE")).toContain("\ncount: 1\n");
    expect(await ok(["trash", "--empty", "--permanent", "--expected-count", "1"])).toBe("emptied: 1 note erased\n");
    expect(await ok(["trash", "--empty", "--permanent"])).toBe("emptied: 0 notes erased (no-op; Recently Deleted is empty)\n");
    expect(await ok(["trash"])).toBe("trash: 0 notes in Recently Deleted\n");
  });

  it("opens notes through the test opener and reports status", async () => {
    expect(await ok(["open"])).toBe("opened: Overnote\n");
    expect(await ok(["open", "current"])).toMatch(/^opened: [0-9A-Z]{26} .+\n$/);
    const status = await ok(["status"]);
    expect(status).toContain(`database:\n  path: ${helper.database}\n  schema: ${schema}\n`);
    expect(status).toContain(`socket: ${helper.socket}\n`);
    expect(status).toMatch(/\nbackups:\n {2}count: \d+\n/);
    expect(status).toMatch(/\nbuild:\n {2}version: \S+\n {2}core: [0-9a-f]+(-dirty)?\n/);
  });

  it("installs and removes the session hook and the skill in the temp home only", async () => {
    const home = process.env.HOME!;
    const settings = path.join(home, ".claude", "settings.json");
    const installed = await ok(["setup", "--agent", "claude"]);
    expect(installed).toContain("  claude,~/.claude/settings.json,installed\n");
    const hook = JSON.parse(readFileSync(settings, "utf8")).hooks.SessionStart[0].hooks[0];
    // The private build is not on PATH, so the hook runs node plus the script's real path.
    expect(hook).toMatchObject({ type: "command", timeout: 10 });
    expect(hook.command).toMatch(/^"\/[^"]+\/node" "[^"]+" home --limit 3 --pinned-limit 3$/);
    expect(hook.command).toContain(`"${realpathSync(binary.script)}" home`);
    expect(await ok(["setup", "--agent", "claude"])).toContain(",unchanged\n");
    expect(await ok(["setup", "skill"])).toContain("  claude,~/.claude/skills/overnote-axi/SKILL.md,installed\n");
    expect(existsSync(path.join(home, ".claude", "skills", "overnote-axi", "SKILL.md"))).toBe(true);
    expect(await ok(["setup", "skill", "--uninstall"])).toContain(",removed\n");
    expect(await ok(["setup", "--uninstall", "--agent", "claude"])).toContain(",removed\n");
  });
});
