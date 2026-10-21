import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OPEN_NOTE_WARNING, VERIFY_DELAY_MS } from "../../src/commands/write-flow.js";
import { noteDeeplink } from "../../src/domain/deeplink.js";
import { axiError } from "../../src/errors.js";
import { converter } from "../../src/markdown/convert.js";
import { assertIsolated } from "../fixtures/guard.js";
import { harness, splitLines, type Harness } from "./write-helpers.js";

let h: Harness;
let dir: string;

/** Makes another note the one Overnote shows, so writes to the test note skip the verify step. */
function openElsewhere(): void {
  h.fakes.store.currentNoteId = h.seed("Open elsewhere").id;
}

beforeEach(() => {
  h = harness();
  dir = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-content-"));
  assertIsolated(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const unknownNode = { type: "futureWidget", attrs: { payload: 42 } };
const collapsedToggle = {
  type: "list",
  attrs: { kind: "toggle", order: null, checked: false, collapsed: true },
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Details" }] },
    { type: "paragraph", content: [{ type: "text", text: "hidden" }] },
  ],
};

/** A note whose stored document holds blocks markdown cannot express. */
function seedLossy(markdown: string, extra: object[]) {
  const base = converter.fromMarkdown(markdown);
  const doc = JSON.parse(base.rawContent) as { content: object[] };
  return h.fakes.store.add({ ...base, rawContent: JSON.stringify({ type: "doc", content: [...doc.content, ...extra] }) });
}

describe("create", () => {
  it("creates a note from --title and --content and prints the confirmation with hints", async () => {
    const { code, out } = await h.run(["create", "--title", "Standup", "--content", "- [ ] demo"]);
    expect(code).toBe(0);
    const [note] = h.fakes.store.live();
    expect(note?.markdown).toBe("# Standup\n\n- [ ] demo");
    expect(out).toBe(
      [
        "created:",
        `  id: ${note!.id}`,
        "  title: Standup",
        `  updatedAt: ${note!.updatedAt}`,
        "help[2]:",
        `  overnote-axi read ${note!.id}`,
        `  overnote-axi update ${note!.id} --content "<markdown>"`,
        "",
      ].join("\n"),
    );
    expect(h.fakes.writer.calls.find((call) => call.method === "create")?.args[1]).toEqual({});
  });

  it("accepts a title alone, content alone, stdin, and a content file", async () => {
    await h.run(["create", "--title", "Only a title"]);
    await h.run(["create", "--content", "Just text\n"]);
    await h.run(["create", "--content", "-"], { readStdin: async () => "# From stdin\n" });
    const file = path.join(dir, "note.md");
    writeFileSync(file, "# From a file\n\nbody\n");
    await h.run(["create", "--content-file", file]);
    expect(h.fakes.store.live().map((note) => note.markdown)).toEqual([
      "# Only a title",
      "Just text",
      "# From stdin",
      "# From a file\n\nbody",
    ]);
  });

  it("resolves a relative content file against the working directory", async () => {
    writeFileSync(path.join(dir, "rel.md"), "relative");
    const { code } = await h.run(["create", "--content-file", "rel.md"], { cwd: dir });
    expect(code).toBe(0);
    expect(h.fakes.store.live()[0]?.markdown).toBe("relative");
  });

  it("pins with --pin and shows with --open", async () => {
    h.seed("Already pinned", { pinned: 1000 });
    const { code, out } = await h.run(["create", "--content", "Pinned one", "--pin", "--open"]);
    expect(code).toBe(0);
    expect(out).toContain("  pinned: 2\n");
    expect(h.fakes.writer.calls.find((call) => call.method === "create")?.args[1]).toEqual({ show: true });
    expect(h.writes()).toEqual(["create", "pin"]);
  });

  it("refuses an empty note, a multi line title, and two content flags before writing", async () => {
    const cases: string[][] = [
      ["create"],
      ["create", "--content", "   "],
      ["create", "--title", "a\nb"],
      ["create", "--title", "  ", "--content", "body"],
      ["create", "--title=", "--content", "body"],
      ["create", "--content", "x", "--content-file", "y.md"],
    ];
    for (const argv of cases) {
      const { code, out } = await h.run(argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(out).toContain("code: VALIDATION_ERROR");
    }
    expect((await h.run(["create"])).out).toContain("error: a new note needs --title or content\n");
    expect(h.writes()).toEqual([]);
  });

  it("reports a missing content file as IO_ERROR and a terminal stdin as a usage error", async () => {
    const missing = await h.run(["create", "--content-file", path.join(dir, "nope.md")]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("code: IO_ERROR");
    expect(missing.out).toContain("does not exist");

    const tty = await h.run(["create", "--content", "-"]);
    expect(tty.code).toBe(2);
    expect(tty.out).toContain("stdin is a terminal");

    const folder = await h.run(["create", "--content-file", dir]);
    expect(folder.out).toContain("is a directory");
  });

  it("keeps current on the note it named, restoring it after an older helper moved it", async () => {
    const shown = h.seed("Shown in the panel");
    h.fakes.store.currentNoteId = shown.id;
    const { code, out } = await h.run(["create", "--content", "Agent note"]);
    expect(code).toBe(0);
    expect(h.fakes.store.currentNoteId).toBe(shown.id);
    expect(h.writes()).toEqual(["create", "setCurrentNote"]);
    expect(out).not.toContain("warning");

    // A fixed helper leaves current alone, so nothing is restored.
    h.fakes.store.newNotesBecomeCurrent = false;
    await h.run(["create", "--content", "Second"]);
    expect(h.fakes.store.currentNoteId).toBe(shown.id);
    expect(h.writes()).toEqual(["create", "setCurrentNote", "create"]);

    // --open shows the new note, so it stays current.
    const opened = await h.run(["create", "--content", "Shown now", "--open"]);
    expect(h.fakes.store.currentNoteId).toBe(/id: ([0-9A-Z]{26})/.exec(opened.out)?.[1]);
  });

  it("warns when restoring the current note fails, without failing the create", async () => {
    const shown = h.seed("Shown");
    h.fakes.store.currentNoteId = shown.id;
    h.fakes.store.failNext("setCurrentNote", axiError("Overnote could not complete notes.setCurrentNote", "HELPER_ERROR"));
    const { code, out } = await h.run(["create", "--content", "Agent note"]);
    expect(code).toBe(0);
    expect(out).toContain("warning: ");
    expect(out).toContain("restoring the previous current note failed");
  });

  it("names the created note when pinning it fails, so a retry does not create a second one", async () => {
    h.fakes.store.failNext("pin", axiError("Overnote did not answer notes.pin in time; retry once", "HELPER_TIMEOUT"));
    const { code, out } = await h.run(["create", "--content", "Pin me", "--pin"]);
    expect(code).toBe(1);
    const created = h.fakes.store.live()[0]!;
    expect(out).toContain(`created ${created.id}, but pinning it failed`);
    expect(out).toContain("code: HELPER_TIMEOUT");
    expect(out).toContain(`id: ${created.id}`);
    expect(out).toContain(`overnote-axi pin ${created.id}`);
    expect(h.fakes.store.live()).toHaveLength(1);
  });

  it("fails with HELPER_NOT_RUNNING and the open hint while Overnote is closed", async () => {
    h.fakes.store.helperRunning = false;
    const { code, out } = await h.run(["create", "--content", "x"]);
    expect(code).toBe(1);
    expect(out).toContain("code: HELPER_NOT_RUNNING");
    expect(out).toContain("overnote-axi open");
  });
});

describe("update", () => {
  it("appends by default and keeps every stored block, including ones markdown cannot express", async () => {
    const note = seedLossy("# Plan\n\nfirst", [unknownNode, collapsedToggle]);
    openElsewhere();
    const readAt = note.updatedAt;
    const { code, out } = await h.run(["update", note.id, "--content", "- [ ] call Sam"]);
    expect(code).toBe(0);
    const stored = h.stored(note.id);
    const blocks = (JSON.parse(stored.rawContent) as { content: { type: string; attrs?: { collapsed?: boolean } }[] }).content;
    expect(blocks[2]).toEqual(unknownNode);
    expect(blocks[3]?.attrs?.collapsed).toBe(true);
    expect(stored.markdown.endsWith("- [ ] call Sam")).toBe(true);
    expect(out).toBe(
      [
        "updated:",
        `  id: ${note.id}`,
        "  title: Plan",
        "  mode: append",
        `  chars: ${Array.from(stored.text).length}`,
        `  updatedAt: ${stored.updatedAt}`,
        "",
      ].join("\n"),
    );
    // The write carried the stale write token it had just read.
    const update = h.fakes.writer.calls.find((call) => call.method === "update")?.args[0] as { expectedUpdatedAt: number };
    expect(update.expectedUpdatedAt).toBe(readAt);
  });

  it("prepends below the title line, keeping the title", async () => {
    const note = h.seed("# Plan\n\nfirst");
    openElsewhere();
    const { code, out } = await h.run(["update", note.id, "--prepend", "--content", "**Today**"]);
    expect(code).toBe(0);
    expect(h.stored(note.id).markdown).toBe("# Plan\n\n**Today**\n\nfirst");
    expect(out).toContain("  title: Plan\n");
    expect(out).not.toContain("warning");
    // A note that opens with a list has no title line, so prepend goes on top.
    const list = h.seed("- [ ] a");
    await h.run(["update", list.id, "--prepend", "--content", "Tasks"]);
    expect(h.stored(list.id).markdown).toBe("Tasks\n\n- [ ] a");
  });

  it("puts content above the title with --top and warns that the title changed", async () => {
    const note = h.seed("# Plan\n\nfirst");
    openElsewhere();
    const { code, out } = await h.run(["update", note.id, "--top", "--content", "Today"]);
    expect(code).toBe(0);
    expect(h.stored(note.id).markdown).toBe("Today\n\n# Plan\n\nfirst");
    expect(out).toContain("  mode: top\n");
    expect(out).toContain("warning: title changed from 'Plan' to 'Today'\n");
  });

  it("is a no-op when the note already ends or starts with the addition, after normalization", async () => {
    const note = h.seed("# List\n\n- milk");
    const append = await h.run(["update", note.id, "--content", "* milk"]);
    expect(append.code).toBe(0);
    expect(append.out).toContain("  result: (no-op; the note already ends with this content)\n");
    const prepend = await h.run(["update", note.id, "--prepend", "--content", "* milk"]);
    expect(prepend.out).toContain("  result: (no-op; the note already starts with this content)\n");
    const top = await h.run(["update", note.id, "--top", "--content", "# List"]);
    expect(top.out).toContain("  result: (no-op; the note already starts with this content)\n");
    expect(h.writes()).toEqual([]);
  });

  it("does not treat a matching word inside the last line as already present", async () => {
    const note = h.seed("call Sam");
    await h.run(["update", note.id, "--content", "Sam"]);
    expect(h.stored(note.id).markdown).toBe("call Sam\n\nSam");
  });

  it("replaces with --replace behind --expected-updated-at", async () => {
    const note = h.seed("old text");
    const { code, out } = await h.run([
      "update",
      note.id,
      "--replace",
      "--content",
      "new text",
      "--expected-updated-at",
      String(note.updatedAt),
    ]);
    expect(code).toBe(0);
    expect(out).toContain("  mode: replace\n");
    expect(h.stored(note.id).markdown).toBe("new text");

    const same = await h.run(["update", note.id, "--replace", "--content", "new text", "--expected-updated-at", String(h.stored(note.id).updatedAt)]);
    expect(same.out).toContain("(no-op; the note already has exactly this content)");
  });

  it("refuses --replace without --expected-updated-at, and two modes, as usage errors", async () => {
    const note = h.seed("text");
    const missing = await h.run(["update", note.id, "--replace", "--content", "x"]);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain(`overnote-axi read ${note.id} --meta`);
    const both = await h.run(["update", note.id, "--append", "--prepend", "--content", "x"]);
    expect(both.code).toBe(2);
    expect(both.out).toContain("choose one of --append, --prepend, --top, --replace");
    const empty = await h.run(["update", note.id]);
    expect(empty.code).toBe(2);
    expect(empty.out).toContain("update needs content");
    expect(h.writes()).toEqual([]);
  });

  it("refuses a lossy --replace with LOSSY_REWRITE unless --allow-loss", async () => {
    const note = seedLossy("keep", [collapsedToggle]);
    openElsewhere();
    const argv = ["update", note.id, "--replace", "--content", "x", "--expected-updated-at", String(note.updatedAt)];
    const refused = await h.run(argv);
    expect(refused.code).toBe(1);
    expect(splitLines(refused.out)).toEqual([
      "error: rewriting this note through markdown would lose stored content; nothing was written (appending with update keeps every block)",
      "code: LOSSY_REWRITE",
      "losses: collapsed-toggle",
      "help[2]:",
      `  overnote-axi update ${note.id} --content "<markdown>"`,
      "  Repeat the same update with --allow-loss to write anyway",
    ]);
    expect(h.writes()).toEqual([]);

    const forced = await h.run([...argv, "--allow-loss"]);
    expect(forced.code).toBe(0);
    expect(h.stored(note.id).markdown).toBe("x");
  });

  it("fails STALE_WRITE when --expected-updated-at is old, and writes nothing", async () => {
    const note = h.seed("text");
    const { code, out } = await h.run(["update", note.id, "--content", "more", "--expected-updated-at", "5"]);
    expect(code).toBe(1);
    expect(out).toContain("code: STALE_WRITE");
    expect(out).toContain(`updatedAt: ${note.updatedAt}`);
    expect(out).toContain(`overnote-axi read ${note.id}`);
    expect(h.writes()).toEqual([]);
  });

  it("fails STALE_WRITE when the note changes between the fresh read and the write", async () => {
    const note = h.seed("text");
    const { writer, store } = h.fakes;
    const realGet = writer.get.bind(writer);
    writer.get = async (id) => {
      const fresh = await realGet(id);
      store.notes.get(id)!.updatedAt += 50; // another writer lands right after the read
      return fresh;
    };
    const { code, out } = await h.run(["update", note.id, "--content", "more"]);
    expect(code).toBe(1);
    expect(out).toContain("code: STALE_WRITE");
    expect(h.stored(note.id).markdown).toBe("text");
  });

  it("refuses a note in Recently Deleted, and one trashed after it was resolved", async () => {
    const trashed = h.seed("gone", { deletedAt: 1 });
    const first = await h.run(["update", trashed.id, "--content", "x"]);
    expect(first.out).toContain("code: NOTE_TRASHED");
    expect(first.out).toContain(`overnote-axi recover ${trashed.id}`);

    const note = h.seed("live");
    const { writer, store } = h.fakes;
    const realGet = writer.get.bind(writer);
    writer.get = async (id) => {
      store.notes.get(id)!.deletedAt = 99;
      return realGet(id);
    };
    const second = await h.run(["update", note.id, "--content", "x"]);
    expect(second.code).toBe(1);
    expect(second.out).toContain("code: NOTE_TRASHED");
    expect(h.writes()).toEqual([]);
  });

  it("reports an unknown reference as NOTE_NOT_FOUND", async () => {
    const { code, out } = await h.run(["update", "01JAB00000ZZZZZZZZZZZZZZZZ", "--content", "x"]);
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_NOT_FOUND");
  });
});

describe("validation hints", () => {
  it("shell quote a title reference that contains a space", async () => {
    h.seed("Weekly sync");
    const update = await h.run(["update", "title:Weekly sync", "--replace", "--content", "x"]);
    expect(update.code).toBe(2);
    expect(update.out).toContain('overnote-axi read "title:Weekly sync" --meta');
    expect(update.out).toContain('overnote-axi update "title:Weekly sync" --replace --content-file');

    const edit = await h.run(["edit", "title:Weekly sync", "--new", "y"]);
    expect(edit.code).toBe(2);
    expect(edit.out).toContain('overnote-axi read "title:Weekly sync" --full');

    const link = await h.run(["link", "title:Weekly sync", "--prepend"]);
    expect(link.code).toBe(2);
    expect(link.out).toContain('overnote-axi link "title:Weekly sync" --into <note> --prepend');
    expect(h.writes()).toEqual([]);
  });
});

describe("writes to the note open in Overnote", () => {
  it("warns and verifies after the autosave window; other notes skip the wait", async () => {
    const open = h.seed("Open note");
    const other = h.seed("Other note");
    h.fakes.store.currentNoteId = open.id;

    const toOther = await h.run(["update", other.id, "--content", "x"]);
    expect(toOther.slept).toEqual([]);
    expect(toOther.out).not.toContain("warning");

    const toOpen = await h.run(["update", "current", "--content", "y"]);
    expect(toOpen.code).toBe(0);
    expect(toOpen.slept).toEqual([VERIFY_DELAY_MS]);
    expect(toOpen.out).toContain(`warning: ${OPEN_NOTE_WARNING}`);
  });

  it("fails OVERWRITTEN_BY_EDITOR when the editor saves its own version over the write", async () => {
    const note = h.seed("Draft");
    h.fakes.store.currentNoteId = note.id;
    const typed = converter.fromMarkdown("Draft mine");
    const { code, out } = await h.run(["update", note.id, "--content", "From the CLI"], {
      // An editor older than v2.14: its pending save lands during the verify window and wins.
      sleep: async () => {
        Object.assign(h.stored(note.id), typed, { updatedAt: h.stored(note.id).updatedAt + 10 });
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("code: OVERWRITTEN_BY_EDITOR");
    expect(out).toContain(`overnote-axi read ${note.id}`);
  });

  it("fails OVERWRITTEN_BY_EDITOR when an appended copy of a repeated block is saved over", async () => {
    const note = h.seed("# Todo\n\n- [ ] call Sam\n\n---\n\n- [ ] other");
    h.fakes.store.currentNoteId = note.id;
    const before = { ...h.stored(note.id) };
    const { code, out } = await h.run(["update", note.id, "--content", "- [ ] call Sam"], {
      // The older editor saves the version it had, so the appended item is gone while an
      // identical item stays earlier in the note.
      sleep: async () => {
        Object.assign(h.stored(note.id), {
          rawContent: before.rawContent,
          text: before.text,
          updatedAt: h.stored(note.id).updatedAt + 10,
        });
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("code: OVERWRITTEN_BY_EDITOR");
  });

  it("passes when the editor merges its edits with the write, and prints the newest updatedAt", async () => {
    const note = h.seed("Draft");
    h.fakes.store.currentNoteId = note.id;
    const { code, out } = await h.run(["update", note.id, "--content", "From the CLI"], {
      // A v2.14 editor: it merges the person's typing into the written note and saves the merge.
      sleep: async () => {
        const stored = h.stored(note.id);
        const merged = converter.edit(stored, "Draft", "Draft mine", false);
        if (merged.status !== "ok") throw new Error("merge setup failed");
        Object.assign(stored, merged.content, { updatedAt: stored.updatedAt + 10 });
      },
    });
    expect(code).toBe(0);
    expect(h.stored(note.id).markdown).toBe("Draft mine\n\nFrom the CLI");
    expect(out).toContain(`updatedAt: ${h.stored(note.id).updatedAt}`);
    expect(out).toContain("warning:");
  });

  it("passes when the editor only saved the caret", async () => {
    const note = h.seed("Draft");
    h.fakes.store.currentNoteId = note.id;
    const { code } = await h.run(["update", note.id, "--content", "x"], {
      sleep: async () => {
        h.stored(note.id).updatedAt += 1;
      },
    });
    expect(code).toBe(0);
  });
});

describe("edit", () => {
  it("replaces exact text in the matching block only", async () => {
    const note = seedLossy("- [ ] ship\n- [ ] test", [unknownNode]);
    openElsewhere();
    const { code, out } = await h.run(["edit", note.id, "--old", "- [ ] ship", "--new", "- [x] ship"]);
    expect(code).toBe(0);
    const stored = h.stored(note.id);
    expect(stored.markdown.startsWith("- [x] ship\n- [ ] test")).toBe(true);
    expect((JSON.parse(stored.rawContent) as { content: object[] }).content.at(-1)).toEqual(unknownNode);
    expect(out).toBe(
      ["edited:", `  id: ${note.id}`, "  title: ship", "  replaced: 1", `  updatedAt: ${stored.updatedAt}`, ""].join("\n"),
    );
  });

  it("replaces every occurrence with --all and says when the whole note was rewritten", async () => {
    const note = h.seed("2025 plan\n\nbudget 2025");
    const all = await h.run(["edit", note.id, "--old", "2025", "--new", "2026", "--all"]);
    expect(all.out).toContain("  replaced: 2\n");
    expect(h.stored(note.id).markdown).toBe("2026 plan\n\nbudget 2026");

    const spanning = await h.run(["edit", note.id, "--old", "plan\n\nbudget", "--new", "plan and budget"]);
    expect(spanning.code).toBe(0);
    expect(spanning.out).toContain("  scope: whole note\n");
    expect(h.stored(note.id).markdown).toBe("2026 plan and budget 2026");
  });

  it("deletes text with --new=", async () => {
    const note = h.seed("keep drop");
    await h.run(["edit", note.id, "--old", " drop", "--new="]);
    expect(h.stored(note.id).markdown).toBe("keep");
  });

  it("reports TEXT_NOT_FOUND and AMBIGUOUS_TEXT without writing", async () => {
    const note = h.seed("a b\n\na c");
    const missing = await h.run(["edit", note.id, "--old", "zzz", "--new", "y"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("code: TEXT_NOT_FOUND");
    expect(missing.out).toContain(`overnote-axi read ${note.id} --full`);

    const ambiguous = await h.run(["edit", note.id, "--old", "a", "--new", "y"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.out).toContain("code: AMBIGUOUS_TEXT");
    expect(ambiguous.out).toContain("matches: 2");
    expect(ambiguous.out).toContain(`overnote-axi edit ${note.id} --old a --new y --all`);
    expect(h.writes()).toEqual([]);
  });

  it("is a no-op when --old equals --new, after the same checks as any edit", async () => {
    const note = h.seed("same\n\nsame");
    const noop = await h.run(["edit", note.id, "--old", "same", "--new", "same", "--all"]);
    expect(noop.code).toBe(0);
    expect(noop.out).toContain("  title: same\n");
    expect(noop.out).toContain("  result: (no-op; --old and --new are the same)\n");
    const missing = await h.run(["edit", note.id, "--old", "gone", "--new", "gone"]);
    expect(missing.out).toContain("code: TEXT_NOT_FOUND");
    const ambiguous = await h.run(["edit", note.id, "--old", "same", "--new", "same"]);
    expect(ambiguous.out).toContain("code: AMBIGUOUS_TEXT");
    const stale = await h.run(["edit", note.id, "--old", "same", "--new", "same", "--all", "--expected-updated-at", "1"]);
    expect(stale.out).toContain("code: STALE_WRITE");
    expect(h.writes()).toEqual([]);
  });

  it("is a no-op when the same edit is retried after it landed", async () => {
    const note = h.seed("- [ ] ship\n- [ ] test");
    const first = await h.run(["edit", note.id, "--old", "- [ ] ship", "--new", "- [x] ship"]);
    expect(first.code).toBe(0);
    const retry = await h.run(["edit", note.id, "--old", "- [ ] ship", "--new", "- [x] ship"]);
    expect(retry.code).toBe(0);
    expect(retry.out).toContain("  result: (no-op; already applied since --old is gone and --new is there once as whole lines)\n");
    expect(h.writes()).toEqual(["update"]);
    // Deleting text has nothing to find on a retry, so it still reports TEXT_NOT_FOUND.
    await h.run(["edit", note.id, "--old", "\n- [ ] test", "--new="]);
    const again = await h.run(["edit", note.id, "--old", "\n- [ ] test", "--new="]);
    expect(again.out).toContain("code: TEXT_NOT_FOUND");
  });

  it("is a no-op when an As of line edit is retried", async () => {
    const note = h.seed("Standup\n\nAs of Oct 19\n\n- [ ] ship");
    await h.run(["edit", note.id, "--old", "As of Oct 19", "--new", "As of Oct 20"]);
    const retry = await h.run(["edit", note.id, "--old", "As of Oct 19", "--new", "As of Oct 20"]);
    expect(retry.code).toBe(0);
    expect(retry.out).toContain("(no-op; already applied");
    expect(h.writes()).toEqual(["update"]);
  });

  it("reports TEXT_NOT_FOUND when --new only matches part of a line or the edit used --all", async () => {
    const box = h.seed("- [x] done");
    const partial = await h.run(["edit", box.id, "--old", "nowhere", "--new", "x"]);
    expect(partial.code).toBe(1);
    expect(partial.out).toContain("code: TEXT_NOT_FOUND");

    const call = h.seed("- [ ] call Sam");
    const word = await h.run(["edit", call.id, "--old", "Bob", "--new", "Sam"]);
    expect(word.out).toContain("code: TEXT_NOT_FOUND");

    const many = h.seed("2025 plan\n\nbudget 2025");
    await h.run(["edit", many.id, "--old", "2025 plan", "--new", "2026 plan", "--all"]);
    const allRetry = await h.run(["edit", many.id, "--old", "2025 plan", "--new", "2026 plan", "--all"]);
    expect(allRetry.out).toContain("code: TEXT_NOT_FOUND");
    expect(h.writes()).toEqual(["update"]);
  });

  it("counts a match that spans blocks even when another one sits inside a block", async () => {
    const note = h.seed("a b\n\nc a\n\nb");
    // Only the span matches here, so the whole note is rewritten once.
    const spanOnly = await h.run(["edit", note.id, "--old", "a\n\nb", "--new", "x"]);
    expect(spanOnly.code).toBe(0);
    expect(spanOnly.out).toContain("  scope: whole note\n");
    // A block match next to a span: the count is the whole note's, so the span is not ignored.
    const spanAndBlock = h.seed("a\n\nb a\n\nb");
    const counted = await h.run(["edit", spanAndBlock.id, "--old", "a\n\nb", "--new", "x"]);
    expect(counted.code).toBe(1);
    expect(counted.out).toContain("code: AMBIGUOUS_TEXT");
    expect(counted.out).toContain("matches: 2");
  });

  it("refuses a lossy block edit unless --allow-loss", async () => {
    const note = seedLossy("intro", [collapsedToggle]);
    const refused = await h.run(["edit", note.id, "--old", "hidden", "--new", "shown"]);
    expect(refused.out).toContain("code: LOSSY_REWRITE");
    expect(refused.out).toContain("losses: collapsed-toggle");
    const forced = await h.run(["edit", note.id, "--old", "hidden", "--new", "shown", "--allow-loss"]);
    expect(forced.code).toBe(0);
    expect(h.stored(note.id).markdown).toContain("shown");
  });

  it("requires --old and --new", async () => {
    const note = h.seed("x");
    for (const argv of [
      ["edit", note.id, "--new", "y"],
      ["edit", note.id, "--old=", "--new", "y"],
      ["edit", note.id, "--old", "x"],
    ]) {
      const { code, out } = await h.run(argv);
      expect(code).toBe(2);
      expect(out).toContain("code: VALIDATION_ERROR");
    }
  });

  it("honors --expected-updated-at", async () => {
    const note = h.seed("x");
    const { out } = await h.run(["edit", note.id, "--old", "x", "--new", "y", "--expected-updated-at", "1"]);
    expect(out).toContain("code: STALE_WRITE");
  });
});

describe("link", () => {
  it("prints the deeplink without writing", async () => {
    const note = h.seed("# Groceries [weekly]");
    const { code, out } = await h.run(["link", note.id]);
    expect(code).toBe(0);
    const url = noteDeeplink(note.id);
    expect(splitLines(out)).toEqual(["link:", `  id: ${note.id}`, `  markdown: ${JSON.stringify(`[Groceries \\[weekly\\]](${url})`)}`]);
    expect(h.writes()).toEqual([]);
  });

  it("appends the link into another note as its own paragraph, and is idempotent", async () => {
    const linked = h.seed("Groceries");
    const target = h.seed("Weekly sync");
    const { code, out } = await h.run(["link", linked.id, "--into", target.id]);
    expect(code).toBe(0);
    expect(h.stored(target.id).markdown).toBe(`Weekly sync\n\n[Groceries](${noteDeeplink(linked.id)})`);
    expect(out).toContain(`  into: ${target.id}\n  title: Weekly sync\n  at: end\n`);

    const again = await h.run(["link", linked.id, "--into", target.id]);
    expect(again.out).toContain("(no-op; the note already ends with this link)");
    expect(h.writes()).toEqual(["update"]);
  });

  it("prepends with --prepend and uses --text as the label", async () => {
    const linked = h.seed("Groceries");
    const target = h.seed("Weekly sync");
    await h.run(["link", linked.id, "--into", target.id, "--prepend", "--text", "the list"]);
    expect(h.stored(target.id).markdown).toBe(`Weekly sync\n\n[the list](${noteDeeplink(linked.id)})`);
  });

  it("refuses a self link, --prepend without --into, and a missing target", async () => {
    const note = h.seed("Self");
    const self = await h.run(["link", note.id, "--into", note.id]);
    expect(self.code).toBe(2);
    expect(self.out).toContain("cannot link into itself");

    const prepend = await h.run(["link", note.id, "--prepend"]);
    expect(prepend.code).toBe(2);

    const missing = await h.run(["link", note.id, "--into", "01JAB00000ZZZZZZZZZZZZZZZZ"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("no note matches --into");
    expect(missing.out).toContain("  overnote-axi search 01JAB00000ZZZZZZZZZZZZZZZZ\n");
    expect(missing.out).toContain(`  overnote-axi link ${note.id} --into title:01JAB00000ZZZZZZZZZZZZZZZZ\n`);
    const byTitle = await h.run(["link", note.id, "--into", "Weekly plan"]);
    expect(byTitle.code).toBe(2);
    expect(byTitle.out).toContain("error: 'Weekly plan' is not a note reference\n");
    expect(byTitle.out).toContain('  overnote-axi search "Weekly plan"\n');
    expect(byTitle.out).toContain(`  overnote-axi link ${note.id} --into "title:Weekly plan"\n`);
    expect(h.writes()).toEqual([]);
  });

  it("resolves the linked note and the target in one snapshot", async () => {
    const linked = h.seed("Groceries");
    const target = h.seed("Weekly sync");
    const { reader } = h.fakes;
    const realSnapshot = reader.snapshot.bind(reader);
    let snapshots = 0;
    reader.snapshot = (read) => {
      snapshots += 1;
      return realSnapshot(read);
    };
    expect((await h.run(["link", linked.id, "--into", target.id])).code).toBe(0);
    expect(snapshots).toBe(1);
  });

  it("names the linked note, not --into, when the linked note is missing", async () => {
    const target = h.seed("Target");
    const { code, out } = await h.run(["link", "01JAB00000ZZZZZZZZZZZZZZZZ", "--into", target.id]);
    expect(code).toBe(1);
    expect(out).toContain("code: NOTE_NOT_FOUND");
    expect(out).not.toContain("--into");
    expect(h.writes()).toEqual([]);
  });

  it("refuses to insert a link to a note in Recently Deleted, but still prints its link", async () => {
    const gone = h.seed("Gone", { deletedAt: 5 });
    const target = h.seed("Target");
    expect((await h.run(["link", gone.id])).code).toBe(0);
    const into = await h.run(["link", gone.id, "--into", target.id]);
    expect(into.out).toContain("code: NOTE_TRASHED");
  });

  it("surfaces helper failures from the shared write flow", async () => {
    const linked = h.seed("A");
    const target = h.seed("B");
    h.fakes.store.failNext("update", axiError("Overnote did not answer notes.update in time; retry once", "HELPER_TIMEOUT"));
    const { code, out } = await h.run(["link", linked.id, "--into", target.id]);
    expect(code).toBe(1);
    expect(out).toContain("code: HELPER_TIMEOUT");
  });
});
