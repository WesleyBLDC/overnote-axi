import { describe, expect, it } from "vitest";

import { matchCell } from "../../src/commands/search.js";
import type { SearchHit } from "../../src/domain/types.js";
import { isoDate } from "../../src/output/render.js";
import { fakeContext, summary, type FakeContext } from "../fixtures/fakes.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function search(fake: FakeContext, ...argv: string[]) {
  return runCli(["search", ...argv], fake.context);
}

function seeded() {
  const fake = fakeContext();
  const { store } = fake.fakes;
  const weekly = store.add({ body: "Weekly sync\nWe moved the standup to 9:30 so Sam can join from the train every Tuesday" });
  const standup = store.add({ body: "Standup\n- [ ] demo the CLI" });
  const cafe = store.add({ body: "Café plan\nbuy beans", pinned: 1000 });
  const old = store.add({ body: "Old standup notes", deletedAt: store.clock });
  return { fake, weekly, standup, cafe, old };
}

describe("search", () => {
  it("lists title hits first, then text hits with a snippet", async () => {
    const { fake, weekly, standup } = seeded();
    const { code, out } = await search(fake, "STANDUP");
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        "count: 2 of 2 notes matching 'STANDUP'",
        "hits[2]{id,title,match}:",
        `  ${standup.id},Standup,title`,
        // The snippet starts 30 characters before the match and stops after 80, mid note.
        `  ${weekly.id},Weekly sync,"Weekly sync We moved the standup to 9:30 so Sam can join from the train every Tu..."`,
        "help[1]:",
        "  overnote-axi read <id>",
      ),
    );
  });

  it("folds accents and case like the app", async () => {
    const { fake, cafe } = seeded();
    const { out } = await search(fake, "cafe", "--fields", "id,title,pinned,updated,chars");
    expect(out).toContain("hits[1]{id,title,pinned,updated,chars}:\n");
    expect(out).toContain(`  ${cafe.id},Café plan,1,${isoDate(cafe.updatedAt)},${Array.from(cafe.text).length}\n`);
  });

  it("searches Recently Deleted with --trash", async () => {
    const { fake, old } = seeded();
    const { out } = await search(fake, "standup", "--trash");
    expect(out).toBe(
      lines(
        "count: 1 of 1 note in Recently Deleted matching 'standup'",
        "hits[1]{id,title,match}:",
        `  ${old.id},Old standup notes,title`,
        "help[2]:",
        "  overnote-axi read <id>",
        "  overnote-axi recover <id>",
      ),
    );
  });

  it("hints at a larger limit when hits were cut, keeping the other flags", async () => {
    const fake = fakeContext();
    for (let i = 0; i < 5; i++) fake.fakes.store.add({ body: `Task ${i}` });
    const { out } = await search(fake, "task", "--limit", "2", "--fields", "id");
    expect(out).toContain("count: 2 of 5 notes matching 'task'\n");
    expect(out).toContain("help[2]:\n  overnote-axi search task --limit 5 --fields id\n  overnote-axi read <id>\n");
  });

  it("states zero hits and offers the trash search and create, keeping the other flags", async () => {
    const { fake } = seeded();
    const { code, out } = await search(fake, "zebra crossing", "--fields", "id,title");
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        "hits: 0 notes match 'zebra crossing'",
        "help[2]:",
        '  overnote-axi search "zebra crossing" --trash --fields id,title',
        '  overnote-axi create --content "<markdown>"',
      ),
    );
  });

  it("offers the live search when nothing in the trash matches", async () => {
    const { fake } = seeded();
    const { out } = await search(fake, "zebra", "--trash");
    expect(out).toBe(
      lines(
        "hits: 0 notes in Recently Deleted match 'zebra'",
        "help[2]:",
        "  overnote-axi search zebra",
        '  overnote-axi create --content "<markdown>"',
      ),
    );
  });

  it("quotes the whole count line only when the query needs TOON quoting", async () => {
    const { fake } = seeded();
    const { out } = await search(fake, "beans, milk");
    expect(out.split("\n")[0]).toBe(`hits: "0 notes match 'beans, milk'"`);
  });

  it("quotes a query with an apostrophe in double quotes, so it reads unambiguously", async () => {
    const { fake } = seeded();
    const { out } = await search(fake, "it's");
    expect(out.split("\n")[0]).toBe(`hits: "0 notes match \\"it's\\""`);
  });

  it("rejects a blank query as a usage error", async () => {
    const { fake } = seeded();
    const { code, out } = await search(fake, "   ");
    expect(code).toBe(2);
    expect(out).toContain("code: VALIDATION_ERROR");
    expect(fake.fakes.writer.calls).toEqual([]);
    expect((await search(fake)).code).toBe(2);
  });

  it("caps --limit at 200", async () => {
    const { fake } = seeded();
    expect((await search(fake, "x", "--limit", "201")).code).toBe(2);
  });
});

describe("matchCell", () => {
  const note = (text: string) => summary({ ...fakeContext().fakes.store.add({ body: text }) });
  const hit = (text: string, snippet: string, titleMatch = false): SearchHit => ({ note: note(text), titleMatch, snippet });

  it("is title for a title hit", () => {
    expect(matchCell(hit("Standup", "", true))).toBe("title");
  });

  it("adds an ellipsis only where the text goes on", () => {
    expect(matchCell(hit("one two three", "one two three"))).toBe("one two three");
    expect(matchCell(hit("zero one two", "one two"))).toBe("...one two");
    expect(matchCell(hit("one two three", "one two"))).toBe("one two...");
  });

  it("assumes more text follows when the note is longer than its preview", () => {
    const long = `start ${"x".repeat(300)} end`;
    expect(matchCell(hit(long, "end"))).toBe("...end...");
  });

  it("is empty when there is no snippet", () => {
    expect(matchCell(hit("Title", ""))).toBe("");
  });
});
