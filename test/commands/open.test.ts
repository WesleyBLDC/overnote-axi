import { describe, expect, it } from "vitest";

import { noteDeeplink, openNotesDeeplink } from "../../src/domain/deeplink.js";
import { axiError } from "../../src/errors.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function open(fake: FakeContext, ...argv: string[]) {
  return runCli(["open", ...argv], fake.context);
}

describe("open", () => {
  it("shows the panel through the running helper, Overnote.app or the extension", async () => {
    const fake = fakeContext();
    const { code, out } = await open(fake);
    expect(code).toBe(0);
    expect(out).toBe(lines("opened: Overnote"));
    expect(fake.fakes.writer.calls).toEqual([{ method: "show", args: [undefined] }]);
    expect(fake.opened).toEqual([]);
  });

  it("shows a resolved note through the running helper", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Standup" });
    fake.fakes.store.currentNoteId = note.id;
    const { code, out } = await open(fake, "current");
    expect(code).toBe(0);
    expect(out).toBe(lines(`opened: ${note.id} Standup`));
    expect(fake.fakes.writer.calls).toEqual([{ method: "show", args: [note.id] }]);
    expect(fake.opened).toEqual([]);
  });

  it("starts Overnote.app when nothing runs, then shows the note", async () => {
    const fake = fakeContext({ findApp: () => "/Applications/Overnote.app" });
    const note = fake.fakes.store.add({ body: "Standup" });
    fake.fakes.store.helperRunning = false;
    const { code } = await open(fake, note.id);
    expect(code).toBe(0);
    expect(fake.opened).toEqual(["/Applications/Overnote.app"]);
    expect(fake.fakes.writer.calls).toEqual([{ method: "show", args: [note.id] }]);
  });

  it("says so when a started Overnote.app never answers", async () => {
    const fake = fakeContext({ findApp: () => "/Applications/Overnote.app", openApp: async () => undefined });
    fake.fakes.store.helperRunning = false;
    const { code, out } = await open(fake);
    expect(code).toBe(1);
    expect(out).toContain("code: HELPER_NOT_RUNNING");
    expect(out).toContain("error: Overnote.app started but did not answer");
    expect(fake.fakes.writer.calls).toEqual([]);
  });

  it("falls back to the Raycast deeplink without Overnote.app", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Standup" });
    fake.fakes.store.helperRunning = false;
    expect((await open(fake)).code).toBe(0);
    expect((await open(fake, note.id)).code).toBe(0);
    expect(fake.opened).toEqual([openNotesDeeplink(), noteDeeplink(note.id)]);
    expect(fake.fakes.writer.calls).toEqual([]);
  });

  it("works without a database when no note is named", async () => {
    const fake = fakeContext({ openReader: () => null });
    expect((await open(fake)).code).toBe(0);
    expect(fake.fakes.writer.calls).toEqual([{ method: "show", args: [undefined] }]);
  });

  it("refuses a note in Recently Deleted and opens nothing", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Old", deletedAt: 1 });
    const { code, out } = await open(fake, note.id);
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_TRASHED");
    expect(out).toContain(`  overnote-axi recover ${note.id}`);
    expect(fake.opened).toEqual([]);
    expect(fake.fakes.writer.calls).toEqual([]);
  });

  it("fails with NOTE_NOT_FOUND for an unknown note and opens nothing", async () => {
    const fake = fakeContext();
    const { code, out } = await open(fake, "title:nothing");
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_NOT_FOUND");
    expect(fake.opened).toEqual([]);
  });

  it("gives a failed deeplink opener actionable hints", async () => {
    const fake = fakeContext({
      openUrl: async () => {
        throw axiError("Could not open Overnote (is Raycast installed?)", "IO_ERROR");
      },
    });
    fake.fakes.store.helperRunning = false;
    const { code, out } = await open(fake);
    expect(code).toBe(1);
    expect(out).toBe(
      lines(
        "error: Could not open Overnote (is Raycast installed?)",
        "code: IO_ERROR",
        "help[2]:",
        "  Install Overnote.app (npm run app:install in the Overnote checkout), or enable the Overnote Raycast extension",
        "  overnote-axi status",
      ),
    );
  });

  it("takes at most one note", async () => {
    const fake = fakeContext();
    expect((await open(fake, "current", "current")).code).toBe(2);
  });
});
