import { describe, expect, it } from "vitest";

import { markdownNoteLink } from "../../src/domain/deeplink.js";
import type { Note } from "../../src/domain/types.js";
import { isoDate, isoMinute } from "../../src/output/render.js";
import { fakeContext, type FakeContext } from "../fixtures/fakes.js";
import { lines, runCli } from "../fixtures/run-cli.js";

function read(fake: FakeContext, ...argv: string[]) {
  return runCli(["read", ...argv], fake.context);
}

function meta(note: Note, extra: { state?: string; pinned?: number; deleted?: string; links?: string } = {}): string[] {
  return [
    "note:",
    `  id: ${note.id}`,
    `  title: ${note.title}`,
    `  state: ${extra.state ?? "live"}`,
    ...(extra.pinned === undefined ? [] : [`  pinned: ${extra.pinned}`]),
    ...(extra.deleted === undefined ? [] : [`  deleted: ${extra.deleted}`]),
    `  updated: "${isoMinute(note.updatedAt)}"`,
    `  updatedAt: ${note.updatedAt}`,
    `  created: ${isoDate(note.createdAt)}`,
    `  chars: ${Array.from(note.text).length}`,
    `  links: "${extra.links ?? "0 out, 0 in"}"`,
  ];
}

describe("read", () => {
  it("prints metadata and the markdown body", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "# Standup\n- [ ] demo the CLI\n\nlater" });
    const { code, out } = await read(fake, note.id);
    expect(code).toBe(0);
    expect(out).toBe(lines(...meta(note), "markdown:", "  # Standup", "  - [ ] demo the CLI", "", "  later"));
  });

  it("shows the pin position, link counts and the plain text body", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    const other = store.add({ body: "Groceries", pinned: 1000 });
    const note = store.add({ body: "Standup", pinned: 5000 });
    store.add({ body: `Weekly\n${markdownNoteLink("Standup", note.id)}` });
    store.notes.get(note.id)!.markdown = `# Standup\n${markdownNoteLink("Groceries", other.id)}`;
    store.notes.get(note.id)!.text = "Standup\nGroceries";
    const fresh = store.notes.get(note.id)!;
    const { out } = await read(fake, note.id, "--format", "text");
    expect(out).toBe(lines(...meta(fresh, { pinned: 2, links: "1 out, 1 in" }), "text:", "  Standup", "  Groceries"));
  });

  it("truncates long bodies and hints at --full with the other flags kept", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: `Long\n${"é".repeat(1300)}` });
    const { out } = await read(fake, note.id.slice(-8), "--format", "markdown");
    expect(out).toContain(`  Long\n  ${"é".repeat(1195)}\n  ... (truncated, showing 1200 of 1305 markdown chars)\n`);
    expect(out.endsWith(`help[1]:\n  overnote-axi read ${note.id} --full --format markdown\n`)).toBe(true);

    const full = await read(fake, note.id, "--full");
    expect(full.out).toContain(`  ${"é".repeat(1300)}\n`);
    expect(full.out).not.toContain("truncated");
    expect(full.out).not.toContain("help[");
  });

  it("names the unit of a truncated text body", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "x".repeat(1500) });
    expect((await read(fake, note.id, "--format", "text")).out).toContain("(truncated, showing 1200 of 1500 text chars)");
  });

  it("prints metadata only with --meta", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "x".repeat(1500) });
    const { out } = await read(fake, note.id, "--meta");
    expect(out).toBe(lines(...meta(note)));
  });

  it("reads several notes in order, once each, and hints only the truncated ids", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    const short = store.add({ body: "Short" });
    const long = store.add({ body: "y".repeat(1300) });
    const { out } = await read(fake, long.id, short.id, long.id);
    expect(out.startsWith("count: 2 notes\nnote:\n")).toBe(true);
    expect(out.indexOf(long.id)).toBeLessThan(out.indexOf(short.id));
    expect(out.endsWith(`help[1]:\n  overnote-axi read ${long.id} --full\n`)).toBe(true);
  });

  it("shows a trashed note with its state and deletion date", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Old draft", deletedAt: 1_792_100_000_000 });
    const { code, out } = await read(fake, note.id);
    expect(code).toBe(0);
    expect(out).toBe(lines(...meta(note, { state: "trashed", deleted: isoDate(1_792_100_000_000) }), "markdown:", "  Old draft"));
  });

  it("prints an empty body definitively", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    const empty = store.add({ body: "", title: "" });
    const blank = store.add({ body: "\n\n", title: "" });
    expect((await read(fake, empty.id)).out).toContain("  title: Untitled\n");
    expect((await read(fake, empty.id)).out.endsWith("markdown: (empty)\n")).toBe(true);
    expect((await read(fake, blank.id)).out.endsWith("markdown: (empty)\n")).toBe(true);
  });

  it("resolves current, title: and id fragments", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    const groceries = store.add({ body: "Groceries" });
    store.add({ body: "Other" });
    store.currentNoteId = groceries.id;
    for (const ref of ["current", "title:groceries", groceries.id.slice(0, 26).toLowerCase(), groceries.id.slice(-6)]) {
      const { code, out } = await read(fake, ref, "--meta");
      expect(code, ref).toBe(0);
      expect(out, ref).toContain(`  id: ${groceries.id}\n`);
    }
  });

  it("fails with NOTE_NOT_FOUND and AMBIGUOUS_NOTE from resolution", async () => {
    const fake = fakeContext();
    const { store } = fake.fakes;
    store.add({ body: "Same" });
    store.add({ body: "Same" });
    const missing = await read(fake, "title:nothing");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("code: NOTE_NOT_FOUND");
    const ambiguous = await read(fake, "title:same");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.out).toContain("code: AMBIGUOUS_NOTE");
    expect(ambiguous.out).toContain("candidates[2]{id,title,state}:");
  });

  it("fails the whole read when any reference fails", async () => {
    const fake = fakeContext();
    const note = fake.fakes.store.add({ body: "Here" });
    const { code, out } = await read(fake, note.id, "01JAB00000000000000000ZZZZ");
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_NOT_FOUND");
    expect(out).not.toContain("note:");
  });

  it("rejects a missing reference and a bad format as usage errors", async () => {
    const fake = fakeContext();
    expect((await read(fake)).code).toBe(2);
    expect((await read(fake, "current", "--format", "html")).code).toBe(2);
    expect((await read(fake, "abc")).code).toBe(2);
  });
});
