import { describe, expect, it } from "vitest";

import { noteDeeplink, openNotesDeeplink } from "../../src/domain/deeplink.js";
import { axiError } from "../../src/errors.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function open(fake: FakeContext, ...argv: string[]) {
  return runCli(["open", ...argv], fake.context);
}

describe("open", () => {
  it("opens the panel on the last note without a reference", async () => {
    const fake = fakeContext();
    const { code, out } = await open(fake);
    expect(code).toBe(0);
    expect(out).toBe(lines("opened: Overnote"));
    expect(fake.opened).toEqual([openNotesDeeplink()]);
  });

  it("works without a database when no note is named", async () => {
    const fake = fakeContext({ openReader: () => null });
    expect((await open(fake)).code).toBe(0);
    expect(fake.opened).toEqual([openNotesDeeplink()]);
  });

  it("opens a resolved note through its deeplink", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Standup" });
    fake.fakes.store.currentNoteId = note.id;
    const { code, out } = await open(fake, "current");
    expect(code).toBe(0);
    expect(out).toBe(lines(`opened: ${note.id} Standup`));
    expect(fake.opened).toEqual([noteDeeplink(note.id)]);
    expect(fake.fakes.writer.calls).toEqual([]);
  });

  it("refuses a note in Recently Deleted and opens nothing", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Old", deletedAt: 1 });
    const { code, out } = await open(fake, note.id);
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_TRASHED");
    expect(out).toContain(`  overnote-axi recover ${note.id}`);
    expect(fake.opened).toEqual([]);
  });

  it("fails with NOTE_NOT_FOUND for an unknown note and opens nothing", async () => {
    const fake = fakeContext();
    const { code, out } = await open(fake, "title:nothing");
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_NOT_FOUND");
    expect(fake.opened).toEqual([]);
  });

  it("gives a failed opener actionable hints", async () => {
    const fake = fakeContext({
      openUrl: async () => {
        throw axiError("Could not open Overnote (is Raycast installed?)", "IO_ERROR");
      },
    });
    const { code, out } = await open(fake);
    expect(code).toBe(1);
    expect(out).toBe(
      lines(
        "error: Could not open Overnote (is Raycast installed?)",
        "code: IO_ERROR",
        "help[2]:",
        "  Check that Raycast is installed and the Overnote extension is enabled",
        "  overnote-axi status",
      ),
    );
  });

  it("takes at most one note", async () => {
    const fake = fakeContext();
    expect((await open(fake, "current", "current")).code).toBe(2);
  });
});
