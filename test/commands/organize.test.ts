import { beforeEach, describe, expect, it } from "vitest";

import { axiError } from "../../src/errors.js";
import { converter } from "../../src/markdown/convert.js";
import { harness, splitLines, type Harness } from "./write-helpers.js";

let h: Harness;

beforeEach(() => {
  h = harness();
});

describe("pin and unpin", () => {
  it("pins to the end of the list and reports the position", async () => {
    h.seed("First", { pinned: 1000 });
    const note = h.seed("Standup");
    const { code, out } = await h.run(["pin", note.id]);
    expect(code).toBe(0);
    expect(out).toBe(`pinned: ${note.id} Standup (position 2 of 2)\n`);
    expect(h.stored(note.id).pinned).toBe(2000);
  });

  it("is a no-op on a pinned note, and refuses a trashed one", async () => {
    const pinned = h.seed("Pinned", { pinned: 1000 });
    const again = await h.run(["pin", pinned.id]);
    expect(again.out).toBe(`pinned: ${pinned.id} Pinned (no-op; already at position 1 of 1)\n`);

    const gone = h.seed("Gone", { deletedAt: 1 });
    const trashed = await h.run(["pin", gone.id]);
    expect(trashed.code).toBe(1);
    expect(trashed.out).toContain("code: NOTE_TRASHED");
    expect(trashed.out).toMatch(/^error: note '.+' is in Recently Deleted$/m);
    expect(trashed.out).toContain(`overnote-axi recover ${gone.id}`);
    expect(h.writes()).toEqual([]);
  });

  it("unpins, and is a no-op on an unpinned note", async () => {
    const note = h.seed("Pinned", { pinned: 1000 });
    expect((await h.run(["unpin", note.id])).out).toBe(`unpinned: ${note.id} Pinned\n`);
    expect(h.stored(note.id).pinned).toBeNull();
    expect((await h.run(["unpin", note.id])).out).toBe(`unpinned: ${note.id} Pinned (no-op; not pinned)\n`);
    expect(h.writes()).toEqual(["unpin"]);
  });

  it("needs the helper", async () => {
    const note = h.seed("x");
    h.fakes.store.helperRunning = false;
    const { code, out } = await h.run(["pin", note.id]);
    expect(code).toBe(1);
    expect(out).toContain("code: HELPER_NOT_RUNNING");
  });
});

describe("move", () => {
  function pins() {
    return ["A", "B", "C"].map((title, index) => h.seed(title, { pinned: (index + 1) * 1000 }));
  }

  it("moves one step and reports the new position", async () => {
    const [, , c] = pins();
    const { code, out } = await h.run(["move", c!.id, "up"]);
    expect(code).toBe(0);
    expect(out).toBe(`moved: ${c!.id} C (position 2 of 3)\n`);
  });

  it("stops at the end and says how far it got", async () => {
    const [, b] = pins();
    const { out } = await h.run(["move", b!.id, "down", "--steps", "5"]);
    expect(out).toBe(`moved: ${b!.id} B (position 3 of 3; reached the bottom after 1 of 5 steps)\n`);
    expect(h.writes()).toEqual(["movePinned"]);
  });

  it("is a no-op at the end it moves toward", async () => {
    const [a] = pins();
    const { code, out } = await h.run(["move", a!.id, "up"]);
    expect(code).toBe(0);
    expect(out).toBe(`moved: ${a!.id} A (no-op; already at the top as position 1 of 3)\n`);
    expect(h.writes()).toEqual([]);
  });

  it("refuses an unpinned note with NOT_PINNED and a bad direction as usage", async () => {
    const loose = h.seed("Loose");
    const unpinned = await h.run(["move", loose.id, "up"]);
    expect(unpinned.code).toBe(1);
    expect(unpinned.out).toContain("code: NOT_PINNED");
    expect(unpinned.out).toContain(`overnote-axi pin ${loose.id}`);
    expect((await h.run(["move", loose.id, "left"])).code).toBe(2);
  });
});

describe("duplicate", () => {
  beforeEach(() => {
    h.fakes.store.helperVersion = "0.5.0";
  });

  it("sends the suffixed content in the one duplicate call, with no update", async () => {
    const source = h.seed("# Plan\n\n- milk");
    const { code, out } = await h.run(["duplicate", source.id, "--suffix", " (draft)"]);
    expect(code).toBe(0);
    const copy = h.fakes.store.live().find((note) => note.id !== source.id)!;
    expect(copy).toMatchObject({ title: "Plan (draft)", markdown: "# Plan (draft)\n\n- milk", text: "Plan (draft)\n\nmilk" });
    expect(splitLines(out)).toEqual([
      "duplicated:",
      `  id: ${copy.id}`,
      "  title: Plan (draft)",
      `  from: ${source.id}`,
      `  updatedAt: ${copy.updatedAt}`,
      "help[2]:",
      `  overnote-axi read ${copy.id}`,
      `  overnote-axi update ${copy.id} --content "<markdown>"`,
    ]);
    expect(h.fakes.writer.calls.map((call) => call.method)).toEqual(["ping", "get", "duplicate"]);
    expect(h.writes()).toEqual(["duplicate"]);
    const [id, content] = h.fakes.writer.calls.find((call) => call.method === "duplicate")!.args;
    expect(id).toBe(source.id);
    expect(content).toEqual({ rawContent: copy.rawContent, markdown: copy.markdown, text: copy.text, title: copy.title });
    expect(h.stored(source.id).markdown).toBe("# Plan\n\n- milk");
  });

  it("loads the converter before the fresh read, so the read sits right before the write", async () => {
    const source = h.seed("Plan");
    const callsAtLoad: string[][] = [];
    const loadConverter = async () => {
      callsAtLoad.push(h.fakes.writer.calls.map((call) => call.method));
      return converter;
    };
    expect((await h.run(["duplicate", source.id, "--suffix", " x"], { loadConverter })).code).toBe(0);
    expect(callsAtLoad).toEqual([["ping"]]);
    expect(h.fakes.writer.calls.map((call) => call.method)).toEqual(["ping", "get", "duplicate"]);
  });

  it("FakeWriter.duplicate refuses content without rawContent, as the 0.5.0 helper does", async () => {
    const source = h.seed("Plan");
    const { rawContent: _raw, ...bare } = converter.fromMarkdown("Plan x");
    await expect(h.fakes.writer.duplicate(source.id, bare as never)).rejects.toMatchObject({ code: "HELPER_ERROR" });
    expect(h.fakes.store.live()).toHaveLength(1);
  });

  it("without --suffix makes one exact duplicate call, on any helper", async () => {
    const source = h.seed("Plan");
    h.fakes.store.newNotesBecomeCurrent = false;
    h.fakes.store.helperVersion = "0.4.0";
    expect((await h.run(["duplicate", source.id, "--suffix="])).code).toBe(0);
    expect((await h.run(["duplicate", source.id])).code).toBe(0);
    expect(h.writes()).toEqual(["duplicate", "duplicate"]);
    expect(h.fakes.writer.calls.filter((call) => call.method === "duplicate").map((call) => call.args)).toEqual([
      [source.id],
      [source.id],
    ]);
    expect(h.fakes.store.live().map((note) => note.title)).toEqual(["Plan", "Plan", "Plan"]);
  });

  it("refuses --suffix before any write on a helper older than 0.5.0", async () => {
    const source = h.seed("Plan");
    for (const version of ["0.4.0", "dev"]) {
      h.fakes.store.helperVersion = version;
      const { code, out } = await h.run(["duplicate", source.id, "--suffix", " copy"]);
      expect(code).toBe(1);
      expect(out).toContain(`needs Overnote helper 0.5.0 or newer, and the running helper is ${version}; update Overnote, then run overnote-axi open`);
      expect(out).toContain("code: HELPER_ERROR");
      expect(out).toContain("  overnote-axi open\n");
      expect(out).toContain(`  overnote-axi duplicate ${source.id}\n`);
    }
    expect(h.writes()).toEqual([]);
    expect(h.fakes.store.live()).toHaveLength(1);
  });

  it("refuses a note in Recently Deleted", async () => {
    const gone = h.seed("Gone", { deletedAt: 1 });
    expect((await h.run(["duplicate", gone.id])).out).toContain("code: NOTE_TRASHED");
  });

  it("keeps current on the note it named", async () => {
    const shown = h.seed("Shown");
    const source = h.seed("Plan");
    h.fakes.store.currentNoteId = shown.id;
    expect((await h.run(["duplicate", source.id])).code).toBe(0);
    expect(h.fakes.store.currentNoteId).toBe(shown.id);
    expect(h.writes()).toEqual(["duplicate", "setCurrentNote"]);
    expect((await h.run(["duplicate", source.id, "--suffix", " copy"])).code).toBe(0);
    expect(h.fakes.store.currentNoteId).toBe(shown.id);
    expect(h.writes()).toEqual(["duplicate", "setCurrentNote", "duplicate", "setCurrentNote"]);
  });
});

describe("delete and recover", () => {
  it("moves a note to Recently Deleted with a recover hint, and is a no-op the second time", async () => {
    const note = h.seed("Standup", { pinned: 1000 });
    const first = await h.run(["delete", note.id]);
    expect(splitLines(first.out)).toEqual([
      `deleted: ${note.id} Standup (in Recently Deleted)`,
      "help[1]:",
      `  overnote-axi recover ${note.id}`,
    ]);
    expect(h.stored(note.id).deletedAt).not.toBeNull();
    expect(h.stored(note.id).pinned).toBeNull();

    const second = await h.run(["delete", note.id]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("(no-op; already in Recently Deleted)");
    expect(h.writes()).toEqual(["trash"]);
  });

  it("recovers a trashed note, and is a no-op on a live one", async () => {
    const note = h.seed("Back", { deletedAt: 5 });
    const { code, out } = await h.run(["recover", note.id]);
    expect(code).toBe(0);
    expect(splitLines(out)).toEqual([
      `recovered: ${note.id} Back`,
      "help[2]:",
      `  overnote-axi read ${note.id}`,
      `  overnote-axi pin ${note.id}`,
    ]);
    expect(h.stored(note.id).deletedAt).toBeNull();
    expect((await h.run(["recover", note.id])).out).toBe(`recovered: ${note.id} Back (no-op; not in Recently Deleted)\n`);
  });

  it("erases with --permanent and a full id, trashing a live note first", async () => {
    const note = h.seed("Doomed");
    const { code, out } = await h.run(["delete", note.id, "--permanent"]);
    expect(code).toBe(0);
    expect(out).toBe(`deleted: ${note.id} Doomed (erased permanently)\n`);
    expect(h.fakes.store.notes.has(note.id)).toBe(false);
    expect(h.writes()).toEqual(["trash", "permanentlyDelete"]);
  });

  it("reports an already erased note as a no-op, even without a database row", async () => {
    const id = "01JAB00000ZZZZZZZZZZZZZZZZ";
    const { code, out } = await h.run(["delete", id, "--permanent"]);
    expect(code).toBe(0);
    expect(out).toBe(`deleted: ${id} (no-op; no note with this id exists)\n`);

    const note = h.seed("Racing", { deletedAt: 1 });
    h.fakes.store.failNext("permanentlyDelete", axiError("No note matches that id", "NOTE_NOT_FOUND"));
    expect((await h.run(["delete", note.id, "--permanent"])).out).toContain("(no-op; already erased)");
  });

  it("refuses a fragment, a title, and current with --permanent, naming the full id but never hinting the erase", async () => {
    const note = h.seed("Exact");
    const fragment = await h.run(["delete", note.id.slice(-8), "--permanent"]);
    expect(fragment.code).toBe(2);
    expect(fragment.out).toContain(`'${note.id.slice(-8)}' is ${note.id} Exact`);
    expect(fragment.out).toContain(`overnote-axi read ${note.id} --meta`);
    expect(fragment.out).not.toMatch(/help[^]*--permanent/);

    const title = await h.run(["delete", "title:Exact", "--permanent"]);
    expect(title.code).toBe(2);
    expect(title.out).toContain(`is ${note.id} Exact`);
    expect(title.out).not.toMatch(/help[^]*--permanent/);

    const current = await h.run(["delete", "current", "--permanent"]);
    expect(current.code).toBe(2);
    expect(current.out).toContain("does not accept current");
    expect(h.writes()).toEqual([]);
    expect(h.fakes.store.notes.has(note.id)).toBe(true);
  });

  it("reports a HELPER_ERROR when the helper skipped the erase because the note was recovered meanwhile", async () => {
    const note = h.seed("Recovered", { deletedAt: 1 });
    const { writer } = h.fakes;
    writer.permanentlyDelete = async (id) => {
      h.stored(id).deletedAt = null;
    };
    const { code, out } = await h.run(["delete", note.id, "--permanent"]);
    expect(code).toBe(1);
    expect(out).toContain("code: HELPER_ERROR");
    expect(out).toContain("it was recovered meanwhile");
    expect(out).not.toContain("erased permanently");
  });

  it("does not erase when the helper does not confirm the note is in Recently Deleted", async () => {
    const note = h.seed("Stubborn");
    const { writer } = h.fakes;
    writer.trash = async () => undefined;
    const { code, out } = await h.run(["delete", note.id, "--permanent"]);
    expect(code).toBe(1);
    expect(out).toContain("code: HELPER_ERROR");
    expect(h.fakes.store.notes.has(note.id)).toBe(true);
  });
});

describe("trash", () => {
  it("states the empty Recently Deleted definitively", async () => {
    h.seed("live");
    expect(await h.run(["trash"])).toMatchObject({ code: 0, out: "trash: 0 notes in Recently Deleted\n" });
  });

  it("lists Recently Deleted, newest deletion first, with paging that keeps the flags", async () => {
    const old = h.seed("Old draft", { deletedAt: 100 });
    const recent = h.seed("Recent draft", { deletedAt: 200 });
    const { code, out } = await h.run(["trash", "--limit", "1", "--fields", "id,title"]);
    expect(code).toBe(0);
    expect(splitLines(out)).toEqual([
      "count: 1 of 2 notes in Recently Deleted",
      "trash[1]{id,title}:",
      `  ${recent.id},Recent draft`,
      "help[2]:",
      "  overnote-axi trash --limit 1 --offset 1 --fields id,title",
      "  overnote-axi recover <id>",
    ]);
    const next = await h.run(["trash", "--limit", "1", "--offset", "1"]);
    expect(next.out).toContain(`  ${old.id},Old draft,`);
  });

  it("says when the offset is past the end and points back at the first page", async () => {
    h.seed("Gone", { deletedAt: 1 });
    const { code, out } = await h.run(["trash", "--offset", "5", "--fields", "id,title"]);
    expect(code).toBe(0);
    expect(splitLines(out)).toEqual([
      "count: 0 of 1 note in Recently Deleted (offset 5 is past the end)",
      "help[1]:",
      "  overnote-axi trash --fields id,title",
    ]);
  });

  it("explains --empty without --permanent, with the count", async () => {
    h.seed("a", { deletedAt: 1 });
    h.seed("b", { deletedAt: 2 });
    const { code, out } = await h.run(["trash", "--empty"]);
    expect(code).toBe(2);
    expect(out).toContain("--empty erases all 2 notes in Recently Deleted for good and needs --permanent");
    expect(splitLines(out).slice(-2)).toEqual(["help[1]:", "  overnote-axi trash"]);
    expect(h.writes()).toEqual([]);
  });

  it("speaks of one note in the singular", async () => {
    const gone = h.seed("a", { deletedAt: 1 });
    expect((await h.run(["trash"])).out).toContain("count: 1 of 1 note in Recently Deleted\n");
    expect((await h.run(["trash", "--empty"])).out).toContain("--empty erases the 1 note in Recently Deleted for good");
    expect((await h.run(["trash", "--empty", "--permanent"])).out).toContain("emptied: 1 note erased");
    expect(() => h.stored(gone.id)).toThrow();
  });

  it("empties with --empty --permanent, guarded by --expected-count", async () => {
    h.seed("a", { deletedAt: 1 });
    h.seed("b", { deletedAt: 2 });
    const live = h.seed("kept");

    const stale = await h.run(["trash", "--empty", "--permanent", "--expected-count", "1"]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("code: STALE_WRITE");
    expect(stale.out).toContain("count: 2");
    expect(splitLines(stale.out).slice(-2)).toEqual(["help[1]:", "  overnote-axi trash"]);
    expect(h.writes()).toEqual([]);

    const emptied = await h.run(["trash", "--empty", "--permanent", "--expected-count", "2"]);
    expect(emptied).toMatchObject({ code: 0, out: "emptied: 2 notes erased\n" });
    expect([...h.fakes.store.notes.keys()]).toEqual([live.id]);

    const again = await h.run(["trash", "--empty", "--permanent"]);
    expect(again.out).toBe("emptied: 0 notes erased (no-op; Recently Deleted is empty)\n");
    expect(h.writes()).toEqual(["emptyTrash"]);
  });

  it("reports when the helper erased a different number than was checked", async () => {
    h.seed("a", { deletedAt: 1 });
    h.fakes.writer.emptyTrash = async () => 2;
    const { code, out } = await h.run(["trash", "--empty", "--permanent", "--expected-count", "1"]);
    expect(code).toBe(0);
    expect(out).toBe("emptied: 2 notes erased (1 note checked before; the trash changed meanwhile)\n");
  });

  it("never offers a --permanent command in a hint", async () => {
    h.seed("a", { deletedAt: 1 });
    for (const argv of [
      ["trash"],
      ["trash", "--empty"],
      ["trash", "--empty", "--permanent", "--expected-count", "7"],
      ["trash", "--empty", "--limit", "1"],
      ["trash", "--permanent"],
    ]) {
      const { out } = await h.run(argv);
      const help = out.slice(out.indexOf("help["));
      expect(help).not.toContain("--permanent");
    }
  });

  it("rejects flags that do not fit the mode", async () => {
    for (const argv of [
      ["trash", "--permanent"],
      ["trash", "--expected-count", "3"],
      ["trash", "--empty", "--permanent", "--limit", "5"],
    ]) {
      const { code, out } = await h.run(argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(out).toContain("code: VALIDATION_ERROR");
    }
  });
});
