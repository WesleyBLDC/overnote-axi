/**
 * The performance budget of docs/DESIGN.md section 10, measured on the built binary relative to
 * the `node -e 0` floor of this machine: the version fast path, help, the read commands on 1,000
 * notes, content writes, and organize writes against the real OvernoteHelper. Each path takes the
 * fastest of several runs (see `fastest()`), and so does its floor, which is sampled interleaved
 * with the path's own runs so that load from other test workers weighs on both alike.
 *
 * Set OVERNOTE_AXI_PERF_REPORT=1 to print the measured numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNotesDb, type NotesDbFixture } from "../fixtures/notes-db.js";
import { HELPER_MISSING, helperBinary, startTempHelper, type TempHelper } from "../fixtures/temp-helper.js";
import { buildBinary, isolatedEnv, runBinary, timeNode, TIMING_RUNS, type BuiltBinary } from "./binary.js";

const RUNS = TIMING_RUNS;
const BUDGET_MS = {
  version: 10,
  help: 20,
  read: 40,
  contentWrite: 150,
  organizeWrite: 60,
} as const;

const report: string[] = [];
let binary: BuiltBinary;

interface Measurement {
  /** The fastest run of the CLI. */
  readonly ms: number;
  /** The fastest `node -e 0` run, sampled between the CLI runs. */
  readonly floor: number;
}

/**
 * The fastest of RUNS runs of the built CLI with `argvFor(run)`, failing on a nonzero exit, and
 * the fastest of RUNS `node -e 0` runs taken just before each of them.
 */
function measure(argvFor: (run: number) => readonly string[], env: Readonly<Record<string, string>> = {}): Measurement {
  const processEnv = isolatedEnv(env);
  let ms = Number.POSITIVE_INFINITY;
  let floor = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run += 1) {
    floor = Math.min(floor, timeNode(["-e", "0"], process.env).ms);
    const argv = argvFor(run);
    const result = timeNode([binary.script, ...argv], processEnv);
    expect(result.code, argv.join(" ")).toBe(0);
    ms = Math.min(ms, result.ms);
  }
  return { ms, floor };
}

/** Records the measurement and checks it against its floor + budget. */
function expectWithin(label: string, { ms, floor }: Measurement, budget: number): void {
  report.push(`${label}: ${ms.toFixed(1)} ms (floor ${floor.toFixed(1)} + ${(ms - floor).toFixed(1)}, budget + ${budget})`);
  expect(ms - floor, label).toBeLessThan(budget);
}

beforeAll(() => {
  binary = buildBinary();
});

afterAll(() => {
  binary?.cleanup();
  if (process.env.OVERNOTE_AXI_PERF_REPORT === "1") console.log(report.join("\n"));
});

describe("startup without data", () => {
  it.each(["--version", "-v", "-V"])("answers %s within floor + 10 ms", (flag) => {
    expectWithin(flag, measure(() => [flag]), BUDGET_MS.version);
  });

  it.each([["--help"], ["read", "--help"], ["update", "--help"], ["setup", "--help"]])(
    "prints %j within floor + 20 ms",
    (...argv) => {
      expectWithin(argv.join(" "), measure(() => argv), BUDGET_MS.help);
    },
  );
});

describe("reads on 1,000 notes", () => {
  let db: NotesDbFixture;
  let target: string;

  beforeAll(() => {
    db = createNotesDb();
    for (let i = 1; i <= 9; i += 1) db.add({ body: `Pinned ${i}\nbody of pin ${i}`, pinned: i * 1000 });
    for (let i = 1; i <= 991; i += 1) {
      const note = db.add({ body: `Note ${i}\n- [ ] task ${i}\n${"words for the preview column ".repeat(8)}` });
      if (i === 500) target = note.id;
    }
    db.close();
  });

  afterAll(() => db?.cleanup());

  it.each([
    ["home", []],
    ["home (hook payload)", ["home", "--limit", "3", "--pinned-limit", "3"]],
    ["list", ["list"]],
    ["list --limit 200", ["list", "--limit", "200"]],
    ["search", ["search", "task 777"]],
    ["read", ["read", "<target>"]],
  ] as const)("%s within floor + 40 ms", (label, argv) => {
    const resolved = argv.map((arg) => (arg === "<target>" ? target : arg));
    expectWithin(label, measure(() => resolved, db.env()), BUDGET_MS.read);
  });
});

const available = helperBinary() !== null;
const title = "writes against the real helper";

describe.skipIf(!available)(available ? title : `${title} (skipped: ${HELPER_MISSING})`, () => {
  let helper: TempHelper;
  /** A note that is never the one Overnote shows, so content writes skip the verify wait. */
  let target: string;

  async function create(content: string): Promise<string> {
    const result = await runBinary(binary, ["create", "--content", content], { env: helper.env() });
    expect(result.code, result.stdout).toBe(0);
    const id = /\n {2}id: ([0-9A-Z]{26})\n/.exec(`\n${result.stdout}`)?.[1];
    if (!id) throw new Error(`no id in output:\n${result.stdout}`);
    return id;
  }

  beforeAll(async () => {
    helper = await startTempHelper();
    target = await create("Target\n\nalpha");
    // Newer than the target, so the target is never the fallback current note.
    const shown = await create("Shown");
    await helper.call("notes.setCurrentNote", { noteId: shown });
  });

  afterAll(async () => {
    await helper?.cleanup();
  });

  it("keeps the session hook within floor + 40 ms with the helper running", () => {
    expectWithin("home (hook payload, helper running)", measure(() => ["home", "--limit", "3", "--pinned-limit", "3"], helper.env()), BUDGET_MS.read);
  });

  it("creates a note within floor + 150 ms", () => {
    expectWithin("create", measure((run) => ["create", "--content", `Perf ${run}`], helper.env()), BUDGET_MS.contentWrite);
  });

  it("appends with update within floor + 150 ms", () => {
    expectWithin("update", measure((run) => ["update", target, "--content", `- line ${run}`], helper.env()), BUDGET_MS.contentWrite);
  });

  it("edits a block within floor + 150 ms", () => {
    const words = ["alpha", "beta"] as const;
    const argvFor = (run: number) => ["edit", target, "--old", words[run % 2]!, "--new", words[(run + 1) % 2]!];
    expectWithin("edit", measure(argvFor, helper.env()), BUDGET_MS.contentWrite);
  });

  it("pins and unpins within floor + 60 ms", () => {
    expectWithin("pin/unpin", measure((run) => [run % 2 === 0 ? "pin" : "unpin", target], helper.env()), BUDGET_MS.organizeWrite);
  });

  it("deletes and recovers within floor + 60 ms", () => {
    expectWithin("delete/recover", measure((run) => [run % 2 === 0 ? "delete" : "recover", target], helper.env()), BUDGET_MS.organizeWrite);
  });
});
