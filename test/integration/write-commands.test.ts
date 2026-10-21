/**
 * The write commands against the real OvernoteHelper (test/fixtures/temp-helper.ts), end to end
 * through main() and the production Context: create, read back from SQLite, update with and
 * without a conflict, the open note verify step, edit, link, pin and move, duplicate, delete,
 * recover, and emptying the trash. Everything lives in the helper's throwaway directories, the
 * helper runs headless, and no test passes --open. Skips when the helper binary is not built.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ContextOverrides } from "../../src/context.js";
import { noteDeeplink } from "../../src/domain/deeplink.js";
import type { Note } from "../../src/domain/types.js";
import { converter } from "../../src/markdown/convert.js";
import { createRuntimeContext } from "../../src/runtime.js";
import { openReader } from "../../src/store/readonly-db.js";
import { runCli } from "../fixtures/run-cli.js";
import { HELPER_MISSING, helperBinary, startTempHelper, type TempHelper } from "../fixtures/temp-helper.js";

const available = helperBinary() !== null;
const title = "write commands against the real helper";

/** The id a confirmation block printed. */
function idOf(out: string): string {
  const match = /\n {2}id: ([0-9A-Z]{26})\n/.exec(`\n${out}`);
  if (!match?.[1]) throw new Error(`no id in output:\n${out}`);
  return match[1];
}

describe.skipIf(!available)(available ? title : `${title} (skipped: ${HELPER_MISSING})`, () => {
  let helper: TempHelper;

  function run(argv: string[], overrides: ContextOverrides = {}) {
    // The isolated environment of test/setup.ts, pointed at this helper (OVERNOTE_AXI_OPEN_CMD stays /usr/bin/true).
    const env = { ...process.env, ...helper.env(), OVERNOTE_AXI_OPEN_CMD: "/usr/bin/true" };
    return runCli(argv, createRuntimeContext({ env, ...overrides }));
  }

  function stored(id: string): Note {
    const reader = openReader(helper.database)!;
    try {
      const note = reader.get(id);
      if (!note) throw new Error(`note ${id} is not in SQLite`);
      return note;
    } finally {
      reader.close();
    }
  }

  /** Makes another note the current one, so writes to earlier notes skip the verify wait. */
  async function openElsewhere(): Promise<string> {
    const note = await helper.call("notes.create", converter.fromMarkdown("Open elsewhere"));
    await helper.call("notes.setCurrentNote", { noteId: note.id });
    return note.id;
  }

  function currentId(): string | null {
    const reader = openReader(helper.database)!;
    try {
      return reader.currentNoteId();
    } finally {
      reader.close();
    }
  }

  beforeAll(async () => {
    helper = await startTempHelper();
  });

  afterAll(async () => {
    await helper?.cleanup();
  });

  it("creates notes and reads them back from SQLite", async () => {
    const created = await run(["create", "--title", "Standup", "--content", "- [ ] demo the CLI"]);
    expect(created.code).toBe(0);
    const id = idOf(created.out);
    expect(stored(id)).toMatchObject({ title: "Standup", markdown: "# Standup\n\n- [ ] demo the CLI", pinned: null });

    const piped = await run(["create", "--content", "-", "--pin"], { readStdin: async () => "Piped note\n" });
    expect(piped.code).toBe(0);
    expect(piped.out).toContain("  pinned: 1\n");
    expect(stored(idOf(piped.out)).pinned).not.toBeNull();
  });

  it("appends, prepends, no-ops, and refuses a stale write without changing the note", async () => {
    const id = idOf((await run(["create", "--content", "Plan\n\nfirst"])).out);
    await openElsewhere();

    expect((await run(["update", id, "--content", "- [ ] call Sam"])).code).toBe(0);
    expect((await run(["update", id, "--prepend", "--content", "**Today**"])).code).toBe(0);
    expect(stored(id).markdown).toBe("Plan\n\n**Today**\n\nfirst\n\n- [ ] call Sam");
    const top = await run(["update", id, "--top", "--content", "Agenda"]);
    expect(top.out).toContain("warning: title changed from 'Plan' to 'Agenda'");
    expect(stored(id).markdown).toBe("Agenda\n\nPlan\n\n**Today**\n\nfirst\n\n- [ ] call Sam");

    const noop = await run(["update", id, "--content", "* [ ] call Sam"]);
    expect(noop.out).toContain("(no-op; the note already ends with this content)");

    const before = stored(id);
    const stale = await run(["update", id, "--content", "late", "--expected-updated-at", String(before.updatedAt - 1)]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("code: STALE_WRITE");
    expect(stale.out).toContain(`updatedAt: ${before.updatedAt}`);
    expect(stored(id)).toEqual(before);

    const replaced = await run([
      "update",
      id,
      "--replace",
      "--content",
      "# Rewritten",
      "--expected-updated-at",
      String(before.updatedAt),
    ]);
    expect(replaced.code).toBe(0);
    expect(stored(id).markdown).toBe("# Rewritten");
  });

  it("edits one block and keeps content markdown cannot express", async () => {
    const base = converter.fromMarkdown("- [ ] ship\n- [ ] test");
    const doc = JSON.parse(base.rawContent) as { type: string; content: object[] };
    const widget = { type: "futureWidget", attrs: { payload: 42 } };
    const note = await helper.call("notes.create", {
      ...base,
      rawContent: JSON.stringify({ ...doc, content: [...doc.content, widget] }),
    });
    await openElsewhere();

    const edited = await run(["edit", note.id, "--old", "- [ ] ship", "--new", "- [x] ship"]);
    expect(edited.code).toBe(0);
    expect(edited.out).toContain("  replaced: 1\n");
    const after = stored(note.id);
    expect(after.markdown.startsWith("- [x] ship\n- [ ] test")).toBe(true);
    expect((JSON.parse(after.rawContent) as { content: object[] }).content.at(-1)).toEqual(widget);

    const replace = await run([
      "update",
      note.id,
      "--replace",
      "--content",
      "flat",
      "--expected-updated-at",
      String(after.updatedAt),
    ]);
    expect(replace.out).toContain("code: LOSSY_REWRITE");
    expect(replace.out).toContain("losses: unsupported-content");
    expect(stored(note.id)).toEqual(after);

    const missing = await run(["edit", note.id, "--old", "nowhere", "--new", "elsewhere"]);
    expect(missing.out).toContain("code: TEXT_NOT_FOUND");
    const retried = await run(["edit", note.id, "--old", "- [ ] ship", "--new", "- [x] ship"]);
    expect(retried.code).toBe(0);
    expect(retried.out).toContain("(no-op; already applied");
  });

  it("verifies writes to the open note: a merged save passes, an overwriting save is reported", async () => {
    const id = idOf((await run(["create", "--content", "Draft"])).out);
    // The person switches to it in the panel.
    await helper.call("notes.setCurrentNote", { noteId: id });

    const merged = await run(["update", id, "--content", "From the CLI"], {
      // A merging editor (Overnote v2.14): the person's typing lands around the write.
      sleep: async () => {
        const now = await helper.call("notes.get", { id });
        const typed = converter.edit(now, "Draft", "Draft mine", false);
        if (typed.status !== "ok") throw new Error("setup");
        await helper.call("notes.update", { id, expectedUpdatedAt: now.updatedAt, ...typed.content });
      },
    });
    expect(merged.code).toBe(0);
    expect(merged.out).toContain("warning:");
    expect(stored(id).markdown).toBe("Draft mine\n\nFrom the CLI");
    expect(merged.out).toContain(`updatedAt: ${stored(id).updatedAt}`);

    const overwritten = await run(["update", id, "--content", "Lost line"], {
      // An editor before v2.14: its pending save of the older content wins.
      sleep: async () => {
        const now = await helper.call("notes.get", { id });
        await helper.call("notes.update", { id, ...converter.fromMarkdown("Draft mine\n\nFrom the CLI\n\nTyped") });
        expect(now.markdown.endsWith("Lost line")).toBe(true);
      },
    });
    expect(overwritten.code).toBe(1);
    expect(overwritten.out).toContain("code: OVERWRITTEN_BY_EDITOR");
    expect(overwritten.out).toContain(`overnote-axi read ${id}`);
  });

  it("links one note into another once", async () => {
    const groceries = idOf((await run(["create", "--content", "Groceries"])).out);
    const sync = idOf((await run(["create", "--content", "Weekly sync"])).out);
    await openElsewhere();

    const printed = await run(["link", groceries]);
    expect(printed.out).toContain(noteDeeplink(groceries).slice(0, 40));

    expect((await run(["link", groceries, "--into", sync])).code).toBe(0);
    expect(stored(sync).markdown).toBe(`Weekly sync\n\n[Groceries](${noteDeeplink(groceries)})`);
    expect((await run(["link", groceries, "--into", sync])).out).toContain("(no-op; the note already ends with this link)");
    expect((await run(["link", sync, "--into", sync])).code).toBe(2);
  });

  it("pins, moves, duplicates, deletes, recovers, and empties the trash", async () => {
    const a = idOf((await run(["create", "--content", "Pin A"])).out);
    const b = idOf((await run(["create", "--content", "Pin B"])).out);
    for (const id of [a, b]) expect((await run(["pin", id])).code).toBe(0);
    expect((await run(["pin", a])).out).toContain("(no-op;");

    const moved = await run(["move", b, "up", "--steps", "10"]);
    expect(moved.out).toMatch(/\(position 1 of \d+; reached the top after \d+ of 10 steps\)/);
    expect((await run(["move", b, "up"])).out).toContain("(no-op; already at the top");

    const copy = await run(["duplicate", a, "--suffix", " (copy)"]);
    expect(copy.code).toBe(0);
    const copyId = idOf(copy.out);
    expect(stored(copyId)).toMatchObject({ title: "Pin A (copy)", markdown: "Pin A (copy)", pinned: null });

    expect((await run(["delete", a])).out).toContain("(in Recently Deleted)");
    expect(stored(a).deletedAt).not.toBeNull();
    expect((await run(["pin", a])).out).toContain("code: NOTE_TRASHED");
    expect((await run(["update", a, "--content", "x"])).out).toContain("code: NOTE_TRASHED");
    expect((await run(["recover", a])).out).toBe(`recovered: ${a} Pin A\nhelp[2]:\n  overnote-axi read ${a}\n  overnote-axi pin ${a}\n`);
    expect(stored(a)).toMatchObject({ deletedAt: null, pinned: null });

    const erased = await run(["delete", copyId, "--permanent"]);
    expect(erased.out).toContain("(erased permanently)");
    expect((await run(["delete", copyId, "--permanent"])).out).toContain("(no-op; no note with this id exists)");

    await run(["delete", a]);
    await run(["delete", b]);
    const listing = await run(["trash"]);
    expect(listing.out).toContain("count: 2 of 2 notes in Recently Deleted");
    expect((await run(["trash", "--empty", "--permanent", "--expected-count", "3"])).out).toContain("code: STALE_WRITE");
    expect((await run(["trash", "--empty", "--permanent", "--expected-count", "2"])).out).toBe("emptied: 2 notes erased\n");
    expect((await run(["trash"])).out).toBe("trash: 0 notes in Recently Deleted\n");
  });

  it("writes a duplicate's suffix into its title line, so a later edit keeps the title", async () => {
    const shown = await openElsewhere();
    const source = idOf((await run(["create", "--title", "Groceries", "--content", "**milk**  \neggs\n\n- [ ] bread"])).out);
    const before = stored(source);

    const copy = await run(["duplicate", source, "--suffix", " copy"]);
    expect(copy.code).toBe(0);
    expect(copy.out).toContain("  title: Groceries copy\n");
    const copyId = idOf(copy.out);
    expect(stored(copyId)).toMatchObject({
      title: "Groceries copy",
      markdown: "# Groceries copy\n\n**milk**  \neggs\n\n- [ ] bread",
      text: "Groceries copy\n\nmilk\neggs\n\nbread",
      pinned: null,
    });
    expect(stored(source)).toEqual(before);
    expect(currentId()).toBe(shown);

    // The title comes from the document now, so a content write keeps it.
    expect((await run(["update", copyId, "--content", "- [ ] butter"])).out).not.toContain("title changed");
    expect(stored(copyId).title).toBe("Groceries copy");

    // Without --suffix the copy is exact.
    const exact = idOf((await run(["duplicate", source])).out);
    expect(stored(exact)).toMatchObject({ title: "Groceries", rawContent: before.rawContent, markdown: before.markdown });
  });

  it("leaves current on the note it named after create and duplicate, unless create --open", async () => {
    const shown = await openElsewhere();
    const created = idOf((await run(["create", "--content", "Agent note"])).out);
    expect(currentId()).toBe(shown);
    const copy = await run(["duplicate", created]);
    expect(copy.code).toBe(0);
    expect(currentId()).toBe(shown);
    expect((await run(["read", "current", "--meta"])).out).toContain(`id: ${shown}`);

    // An older helper persisted every new note as current; the restore goes through setCurrentNote.
    await helper.call("notes.setCurrentNote", { noteId: created });
    expect(currentId()).toBe(created);
    await helper.call("notes.setCurrentNote", { noteId: shown });
    expect(currentId()).toBe(shown);
  });

  it("refuses writes once the helper stops, while reads keep working", async () => {
    const id = idOf((await run(["create", "--content", "Last one"])).out);
    await helper.stop();
    const write = await run(["update", id, "--content", "x"]);
    expect(write.code).toBe(1);
    expect(write.out).toContain("code: HELPER_NOT_RUNNING");
    expect(write.out).toContain("overnote-axi open");
    expect((await run(["trash"])).code).toBe(0);
  });
});
