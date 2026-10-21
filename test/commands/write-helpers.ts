/**
 * Shared harness for the write command tests: one in-memory store per test, a fresh fake Context
 * per CLI run (main() closes it), and notes seeded with real core content so document level
 * composition and edits run exactly as in production.
 */
import type { ContextOverrides } from "../../src/context.js";
import type { Note } from "../../src/domain/types.js";
import { converter } from "../../src/markdown/convert.js";
import { createFakes, fakeContext, type FakeNoteInput, type Fakes } from "../fixtures/fakes.js";
import { runCli } from "../fixtures/run-cli.js";

export interface Run {
  code: number;
  out: string;
  slept: number[];
  opened: string[];
}

export interface Harness {
  fakes: Fakes;
  run(argv: string[], overrides?: ContextOverrides): Promise<Run>;
  /** A live note whose stored fields come from core, as the helper would hold them. */
  seed(markdown: string, extra?: FakeNoteInput): Note;
  /** The stored note, straight from the store. */
  stored(id: string): Note;
  /** Writer methods called so far, in order. */
  writes(): string[];
}

const READ_ONLY = new Set(["ping", "status", "get"]);

export function harness(): Harness {
  const fakes = createFakes();
  return {
    fakes,
    async run(argv, overrides = {}) {
      const { context, slept, opened } = fakeContext(overrides, fakes);
      const { code, out } = await runCli(argv, context);
      return { code, out, slept, opened };
    },
    seed(markdown, extra = {}) {
      return fakes.store.add({ ...converter.fromMarkdown(markdown), ...extra });
    },
    stored(id) {
      const note = fakes.store.notes.get(id);
      if (!note) throw new Error(`no stored note ${id}`);
      return note;
    },
    writes() {
      return fakes.writer.calls.map((call) => call.method).filter((method) => !READ_ONLY.has(method));
    },
  };
}

/** The output split into lines, without the final newline (the reverse of run-cli's `lines()`). */
export function splitLines(out: string): string[] {
  return out.replace(/\n$/, "").split("\n");
}
