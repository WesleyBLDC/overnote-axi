import { describe, expect, it } from "vitest";

import { markdownNoteLink, noteDeeplink } from "../../src/domain/deeplink.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function links(fake: FakeContext, ...argv: string[]) {
  return runCli(["links", ...argv], fake.context);
}

const MISSING = "01JAB00000000000000000ZZZZ";

describe("links", () => {
  it("lists outgoing note links (missing targets marked) and backlinks", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    const groceries = store.add({ body: "Groceries" });
    const standup = store.add({ body: "Standup" });
    const weekly = store.add({ body: `Weekly sync\n${markdownNoteLink("Standup", standup.id)}` });
    // Links from notes in Recently Deleted are not backlinks.
    store.add({ body: `Raw\nraycast://extensions/wesleybldc/overnote/toggle-notes?context={"id":"${standup.id}"}`, deletedAt: 1 });
    store.notes.get(standup.id)!.markdown =
      `# Standup\n${markdownNoteLink("Groceries", groceries.id)}\n${noteDeeplink(MISSING)}\n${markdownNoteLink("again", groceries.id)}`;

    const { code, out } = await links(fake, standup.id);
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        `note: ${standup.id} Standup`,
        "outgoing[2]{id,title}:",
        `  ${groceries.id},Groceries`,
        `  ${MISSING},(missing)`,
        "backlinks[1]{id,title}:",
        `  ${weekly.id},Weekly sync`,
        "help[1]:",
        "  overnote-axi read <id>",
      ),
    );
  });

  it("states empty sides definitively and suggests linking", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Lonely" });
    const { code, out } = await links(fake, "title:lonely");
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        `note: ${note.id} Lonely`,
        "outgoing: 0 links",
        "backlinks: 0 notes link here",
        "help[1]:",
        `  overnote-axi link ${note.id} --into <other note>`,
      ),
    );
  });

  it("reads a trashed note and says it is trashed", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Old", deletedAt: 1 });
    const { code, out } = await links(fake, note.id);
    expect(code).toBe(0);
    expect(out.startsWith(`note: ${note.id} Old\nstate: trashed\n`)).toBe(true);
  });

  it("fails with NOTE_NOT_FOUND for an unknown note and a usage error without one", async () => {
    const fake = fakeContext();
    const missing = await links(fake, MISSING);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("code: NOTE_NOT_FOUND");
    expect((await links(fake)).code).toBe(2);
  });
});
