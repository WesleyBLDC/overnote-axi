/**
 * The read commands against the real OvernoteHelper (test/fixtures/temp-helper.ts): notes are
 * arranged with direct RPC calls, then `home`, `status`, `list`, `search`, `read`, `links` and
 * `open` run through the production Context on the helper's own database and socket. `open`
 * runs the recorder from OVERNOTE_AXI_OPEN_CMD (test/setup.ts), never the real opener. Skips
 * when the helper binary is not built.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markdownNoteLink } from "../../src/domain/deeplink.js";
import type { NoteContent } from "../../src/domain/types.js";
import { createRuntimeContext } from "../../src/runtime.js";
import { lines, runCli } from "../fixtures/run-cli.js";
import { HELPER_MISSING, helperBinary, startTempHelper, type TempHelper } from "../fixtures/temp-helper.js";

const available = helperBinary() !== null;

function content(body: string): NoteContent {
  const blocks = body.split("\n");
  const doc = {
    type: "doc",
    content: blocks.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
  return { rawContent: JSON.stringify(doc), markdown: body, text: body, title: blocks.find((line) => line.trim())?.trim() ?? "" };
}

const title = "read commands against the real helper";

describe.skipIf(!available)(available ? title : `${title} (skipped: ${HELPER_MISSING})`, () => {
  let helper: TempHelper;

  function run(...argv: string[]) {
    // The isolated environment of test/setup.ts, pointed at this helper (OVERNOTE_AXI_OPEN_CMD stays /usr/bin/true).
    return runCli(argv, createRuntimeContext({ env: { ...process.env, ...helper.env(), OVERNOTE_AXI_OPEN_CMD: "/usr/bin/true" } }));
  }

  beforeAll(async () => {
    helper = await startTempHelper();
  });

  afterAll(async () => {
    await helper?.cleanup();
  });

  it("shows the empty state, then the notes the helper stored", async () => {
    const empty = await run("home");
    expect(empty.code).toBe(0);
    expect(empty.out).toMatch(/ {2}helper: running v\S+\n {2}notes: 0 live\n/);

    const groceries = await helper.call("notes.create", content("Groceries\nmilk and café beans"));
    await helper.call("notes.pin", { id: groceries.id });
    const standup = await helper.call("notes.create", content(`Standup\n${markdownNoteLink("Groceries", groceries.id)}`));

    const home = await run("home");
    // The newest note either way: current after an older helper's create, else the fallback.
    expect(home.out).toContain(`\ncurrent: ${standup.id} Standup`);
    expect(home.out).toContain(`pinned[1]{id,title,updated}:\n  ${groceries.id},Groceries,`);
    expect(home.out).toContain(`recent[1]{id,title,updated}:\n  ${standup.id},Standup,`);

    const list = await run("list", "--fields", "id,pinned");
    expect(list.out).toContain(`notes[2]{id,pinned}:\n  ${groceries.id},1\n  ${standup.id},""\n`);

    const search = await run("search", "CAFE");
    expect(search.out).toContain(`  ${groceries.id},Groceries,Groceries milk and café beans\n`);

    const read = await run("read", "current");
    expect(read.out).toContain(`  id: ${standup.id}\n  title: Standup\n  state: live\n`);
    expect(read.out).toContain('  links: "1 out, 0 in"\n');
    expect(read.out).toContain(`markdown:\n  Standup\n  ${markdownNoteLink("Groceries", groceries.id)}\n`);

    const links = await run("links", groceries.id);
    expect(links.out).toContain(`backlinks[1]{id,title}:\n  ${standup.id},Standup\n`);

    const open = await run("open", groceries.id.slice(-8));
    expect(open).toEqual({ code: 0, out: lines(`opened: ${groceries.id} Groceries`) });
  });

  it("reports the running helper and its backups in status", async () => {
    const { code, out } = await run("status");
    expect(code).toBe(0);
    expect(out).toContain(`helper:\n  state: running\n  version: `);
    expect(out).toContain(`  pid: ${helper.pid}\n`);
    expect(out).toContain(`database:\n  path: ${helper.database}\n  schema: 1\n`);
    expect(out).toContain(`socket: ${helper.socket}\n`);
    expect(out).toMatch(/backups:\n {2}count: \d+\n {2}latest: \S+\n/);
  });

  it("keeps reads working after the helper stops", async () => {
    await helper.stop();
    const home = await run("home");
    expect(home.code).toBe(0);
    expect(home.out).toContain("  helper: stopped (reads work; writes need overnote-axi open)\n  notes: 2 live\n");
    const status = await run("status");
    expect(status.out).toContain("helper:\n  state: stopped\n");
    expect(status.out).not.toContain("backups:");
    expect((await run("list")).code).toBe(0);
  });
});
