/**
 * The read commands end to end over a real read-only `notes.sqlite` (test/fixtures/notes-db.ts)
 * through the production Context, with the helper stopped: ordering, pin positions, folding,
 * snippets, backlinks, and the database states, as the agent sees them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markdownNoteLink, noteDeeplink } from "../../src/domain/deeplink.js";
import { isoDate } from "../../src/output/render.js";
import { createRuntimeContext } from "../../src/runtime.js";
import { createNotesDb, type NotesDbFixture } from "../fixtures/notes-db.js";
import { lines, runCli } from "../fixtures/run-cli.js";

let db: NotesDbFixture;

beforeEach(() => {
  db = createNotesDb();
});

afterEach(() => db.cleanup());

function run(...argv: string[]) {
  return runCli(argv, createRuntimeContext({ env: { ...process.env, ...db.env() } }));
}

describe("read commands over SQLite", () => {
  it("lists in app order with 1 based pin positions from the stored pin keys", async () => {
    const loose = db.add({ body: "Loose" });
    const second = db.add({ body: "Second pin", pinned: 2000.5 });
    const first = db.add({ body: "First pin", pinned: 1000 });
    db.add({ body: "Trashed", deletedAt: db.now() });
    const { code, out } = await run("list", "--fields", "id,pinned,title");
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        "count: 3 of 3 live notes",
        "notes[3]{id,pinned,title}:",
        `  ${first.id},1,First pin`,
        `  ${second.id},2,Second pin`,
        `  ${loose.id},"",Loose`,
        "help[1]:",
        "  overnote-axi read <id>",
      ),
    );
  });

  it("searches with the app's folding and shows the snippet around the match", async () => {
    const note = db.add({ body: "Trip\nWe should visit the Musée d'Orsay on Tuesday" });
    db.add({ body: "Unrelated" });
    const { out } = await run("search", "MUSEE", "--fields", "id,match,updated");
    expect(out).toContain(`  ${note.id},Trip We should visit the Musée d'Orsay on Tuesday,${isoDate(note.updatedAt)}\n`);
  });

  it("counts and lists backlinks however the link was encoded, and outgoing links in order", async () => {
    const target = db.add({ body: "Target" });
    const encoded = db.add({ body: `Encoded\n${markdownNoteLink("Target", target.id)}` });
    const raw = db.add({
      body: `Raw\nraycast://extensions/wesleybldc/overnote/toggle-notes?context={"id":"${target.id}"}`,
    });
    // A mere mention of the id is not a link.
    db.add({ body: `Mention ${target.id}` });
    db.add({ body: `Gone ${noteDeeplink(target.id)}`, deletedAt: db.now() });

    const read = await run("read", target.id, "--meta");
    expect(read.out).toContain('  links: "0 out, 2 in"\n');

    const links = await run("links", target.id);
    expect(links.out).toBe(
      lines(
        `note: ${target.id} Target`,
        "outgoing: 0 links",
        "backlinks[2]{id,title}:",
        `  ${raw.id},Raw`,
        `  ${encoded.id},Encoded`,
        "help[1]:",
        "  overnote-axi read <id>",
      ),
    );
    expect((await run("links", encoded.id)).out).toContain(`outgoing[1]{id,title}:\n  ${target.id},Target\n`);
  });

  it("shows home with the stopped helper and the current note from settings", async () => {
    const pinned = db.add({ body: "Pinned", pinned: 1000 });
    const current = db.add({ body: "Current" });
    db.add({ body: "Newest" });
    db.setCurrent(current.id);
    const { code, out } = await run("home", "--limit", "3", "--pinned-limit", "3");
    expect(code).toBe(0);
    expect(out).toContain(
      [
        "overnote:",
        "  helper: stopped (reads work; writes need overnote-axi open)",
        "  notes: 3 live",
        "  pinned: 1",
        "  trash: 0",
        `current: ${current.id} Current`,
        "pinned[1]{id,title,updated}:",
        `  ${pinned.id},Pinned,${isoDate(pinned.updatedAt)}`,
        "recent[2]{id,title,updated}:",
      ].join("\n"),
    );
  });

  it("reports the database facts in status", async () => {
    db.add({ body: "One" });
    db.add({ body: "Two", deletedAt: db.now() });
    const { code, out } = await run("status");
    expect(code).toBe(0);
    expect(out).toContain(`database:\n  path: ${db.database}\n  schema: 1\n  notes: 1 live\n  trash: 1\n`);
    expect(out).toContain("helper:\n  state: stopped\n");
  });

  it("degrades home and status on a newer schema, and fails reads with DATABASE_ERROR", async () => {
    db.cleanup();
    db = createNotesDb({ userVersion: 2 });
    const home = await run("home");
    expect(home.code).toBe(0);
    expect(home.out).toContain("  code: DATABASE_ERROR\n  schema: 2\n");
    const status = await run("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("  state: unreadable\n");
    const list = await run("list");
    expect(list.code).toBe(1);
    expect(list.out).toContain("code: DATABASE_ERROR");
  });

  it("degrades home on a file that is not an Overnote database", async () => {
    db.cleanup();
    db = createNotesDb({ noSchema: true });
    const home = await run("home");
    expect(home.code).toBe(0);
    expect(home.out).toContain("  code: DATABASE_ERROR\n");
    expect(home.out).not.toContain("SQLITE");
  });
});
