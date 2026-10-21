import { describe, expect, it } from "vitest";

import type { Note } from "../../src/domain/types.js";
import { isoDate } from "../../src/output/render.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function list(fake: FakeContext, ...argv: string[]) {
  return runCli(["list", ...argv], fake.context);
}

function row(note: Note): string {
  return `  ${note.id},${note.title},${isoDate(note.updatedAt)}`;
}

/** b and a pinned (b first), then c, d, e newest first; one trashed note never listed. */
function seeded() {
  const fake = fakeContext();
  const { store } = fake.fakes;
  const a = store.add({ body: "Alpha", pinned: 2000 });
  const b = store.add({ body: "Bravo", pinned: 1000 });
  const c = store.add({ body: "Charlie\nsecond line" });
  const d = store.add({ body: "Delta, with a comma" });
  const e = store.add({ body: "Echo", lastAccessedAt: 1 });
  store.add({ body: "Trashed", deletedAt: store.clock });
  return { fake, a, b, c, d, e };
}

describe("list", () => {
  it("lists live notes in app order with the aggregate count", async () => {
    const { fake, a, b, c, d, e } = seeded();
    const { code, out } = await list(fake);
    expect(code).toBe(0);
    expect(out).toBe(
      lines(
        "count: 5 of 5 live notes",
        "notes[5]{id,title,updated}:",
        row(b),
        row(a),
        row(e),
        `  ${d.id},"Delta, with a comma",${isoDate(d.updatedAt)}`,
        row(c),
        "help[1]:",
        "  overnote-axi read <id>",
      ),
    );
  });

  it("pages with a hint that carries every other flag forward", async () => {
    const { fake, a, d } = seeded();
    const { out } = await list(fake, "--limit", "2", "--offset", "1", "--sort", "accessed", "--fields", "id,pinned");
    // Pinned first (Bravo, Alpha), then by access: Delta, Charlie, and Echo (accessed longest ago) last.
    expect(out).toBe(
      lines(
        "count: 2 of 5 live notes",
        "notes[2]{id,pinned}:",
        `  ${a.id},2`,
        `  ${d.id},""`,
        "help[2]:",
        "  overnote-axi list --limit 2 --offset 3 --sort accessed --fields id,pinned",
        "  overnote-axi read <id>",
      ),
    );
  });

  it("shows only pinned notes in pin order with --pinned", async () => {
    const { fake } = seeded();
    const { out } = await list(fake, "--pinned", "--fields", "title,pinned");
    expect(out).toBe(
      lines("count: 2 of 2 pinned notes", "notes[2]{title,pinned}:", "  Bravo,1", "  Alpha,2", "help[1]:", "  overnote-axi read <id>"),
    );
  });

  it("renders every optional field", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Title\n\nbody   text\nwith lines", lastAccessedAt: null });
    const { out } = await list(fake, "--fields", "id,title,updated,created,accessed,chars,pinned,preview");
    expect(out).toContain("notes[1]{id,title,updated,created,accessed,chars,pinned,preview}:\n");
    expect(out).toContain(
      `  ${note.id},Title,${isoDate(note.updatedAt)},${isoDate(note.createdAt)},"",${Array.from(note.text).length},"",body text with lines\n`,
    );
  });

  it("keeps deleted for trash only", async () => {
    const { code, out } = await list(fakeContext(), "--fields", "id,deleted");
    expect(code).toBe(2);
    expect(out).toContain("code: VALIDATION_ERROR");
  });

  it("starts the preview after the title and cuts it at 100 characters on one line", async () => {
    const fake = fakeContext();
    fake.fakes.store.add({ body: `Long\n${"é".repeat(150)}` });
    const { out } = await list(fake, "--fields", "preview");
    expect(out).toContain(`  ${"é".repeat(100)}\n`);
  });

  it("sorts by created date with --sort created", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    store.add({ body: "Old but edited", createdAt: 1000, updatedAt: store.clock + 50_000 });
    store.add({ body: "Fresh" });
    const byCreated = await list(fake, "--sort", "created", "--fields", "title");
    expect(byCreated.out).toContain("notes[2]{title}:\n  Fresh\n  Old but edited\n");
    const byUpdated = await list(fake, "--fields", "title");
    expect(byUpdated.out).toContain("notes[2]{title}:\n  Old but edited\n  Fresh\n");
  });

  it("states an empty list definitively", async () => {
    const fake = fakeContext();
    const { code, out } = await list(fake);
    expect(code).toBe(0);
    expect(out).toBe(lines("notes: 0 live notes", "help[1]:", '  overnote-axi create --content "<markdown>"'));
  });

  it("states that nothing is pinned and offers pin", async () => {
    const fake = fakeContext();
    fake.fakes.store.add({ body: "Loose" });
    const { out } = await list(fake, "--pinned");
    expect(out).toBe(lines("notes: 0 pinned notes", "help[2]:", "  overnote-axi pin <id>", "  overnote-axi list"));
  });

  it("says when the offset is past the end and points back at the first page", async () => {
    const { fake } = seeded();
    const { code, out } = await list(fake, "--offset", "40", "--limit", "10");
    expect(code).toBe(0);
    expect(out).toBe(
      lines("count: 0 of 5 live notes (offset 40 is past the end)", "help[1]:", "  overnote-axi list --limit 10"),
    );
  });

  it("rejects unknown fields and sort orders as usage errors", async () => {
    const { fake } = seeded();
    const fields = await list(fake, "--fields", "id,match");
    expect(fields.code).toBe(2);
    expect(fields.out).toContain("error: flag --fields does not accept match\n");
    expect((await list(fake, "--sort", "title")).code).toBe(2);
  });

  it("fails with DATABASE_NOT_FOUND when there is no database", async () => {
    const fake = fakeContext({ openReader: () => null });
    const { code, out } = await list(fake);
    expect(code).toBe(1);
    expect(out).toContain("code: DATABASE_NOT_FOUND");
    expect(out).toContain("overnote-axi open");
  });
});
