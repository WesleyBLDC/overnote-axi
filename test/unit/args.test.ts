import { describe, expect, it } from "vitest";

import { closest, editDistance, parseArgs, rebuildInvocation, renderCommandHelp, wantsHelp } from "../../src/args.js";
import type { CommandSpec } from "../../src/command.js";
import { AxiError } from "../../src/errors.js";

const spec: CommandSpec = {
  name: "demo",
  positionals: [{ name: "<note>", description: "A note", required: true }],
  flags: [
    { name: "limit", type: "number", value: "<n>", min: 1, max: 10, description: "Rows" },
    { name: "full", type: "boolean", description: "All of it" },
    { name: "content", type: "string", value: "<md>", description: "Markdown" },
    { name: "fields", type: "list", value: "<a,b>", choices: ["id", "title"], description: "Columns" },
    { name: "sort", type: "string", value: "<s>", choices: ["updated", "created"], description: "Order" },
  ],
  renamed: [{ name: "body", hint: "Use --content instead" }],
  examples: ["overnote-axi demo current"],
  run: async () => ({ output: "" }),
};

function usageError(run: () => unknown): AxiError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    expect((error as AxiError).code).toBe("VALIDATION_ERROR");
    return error as AxiError;
  }
  throw new Error("expected a usage error");
}

describe("parseArgs", () => {
  it("parses both flag forms, booleans, lists and positionals", () => {
    const args = parseArgs(spec, ["n1", "--limit", "3", "--full", "--fields=id,title", "--content", "- [ ] task"]);
    expect(args.positionals).toEqual(["n1"]);
    expect(args.flags).toEqual({ limit: 3, full: true, fields: ["id", "title"], content: "- [ ] task" });
  });

  it("treats everything after -- as positionals and keeps a lone -", () => {
    const variadic: CommandSpec = { ...spec, positionals: [{ ...spec.positionals[0]!, variadic: true }] };
    expect(parseArgs(variadic, ["-", "--", "--full"]).positionals).toEqual(["-", "--full"]);
  });

  it("allows an empty string value with the = form", () => {
    expect(parseArgs(spec, ["n1", "--content="]).flags.content).toBe("");
  });

  it("rejects unknown flags by name and lists the valid ones", () => {
    const error = usageError(() => parseArgs(spec, ["n1", "--limt", "3"]));
    expect(error.message).toBe("unknown flag --limt for demo (did you mean --limit?)");
    expect(error.suggestions[0]).toBe("overnote-axi demo n1 --limit 3");
    expect(error.suggestions[1]).toBe("valid flags for demo: --limit, --full, --content, --fields, --sort, --help");
    const far = usageError(() => parseArgs(spec, ["n1", "--zzzzzz"]));
    expect(far.message).toBe("unknown flag --zzzzzz for demo");
    expect(far.suggestions[0]).toBe("valid flags for demo: --limit, --full, --content, --fields, --sort, --help");
  });

  it("leads with the corrected invocation and never repeats content", () => {
    expect(usageError(() => parseArgs(spec, ["n1", "--ful", "--content", "- [ ] task"])).suggestions[0]).toBe(
      'overnote-axi demo n1 --full --content "<markdown>"',
    );
    expect(usageError(() => parseArgs(spec, ["n1", "--contnt=secret"])).suggestions[0]).toBe('overnote-axi demo n1 --content "<markdown>"');
    expect(usageError(() => parseArgs(spec, ["n1", "--limt=3"])).suggestions[0]).toBe("overnote-axi demo n1 --limit=3");
  });

  it("suggests the closest value for a choice or list flag", () => {
    const sort = usageError(() => parseArgs(spec, ["n1", "--sort", "updatd", "--full"]));
    expect(sort.message).toBe("flag --sort does not accept updatd (did you mean updated?)");
    expect(sort.suggestions).toEqual(["overnote-axi demo n1 --sort updated --full", "valid values: updated, created", "overnote-axi demo --help"]);
    const fields = usageError(() => parseArgs(spec, ["n1", "--fields=id,titel"]));
    expect(fields.message).toBe("flag --fields does not accept titel (did you mean title?)");
    expect(fields.suggestions[0]).toBe("overnote-axi demo n1 --fields=id,title");
    const far = usageError(() => parseArgs(spec, ["n1", "--sort", "zzzzzz"]));
    expect(far.suggestions[0]).toBe("valid values: updated, created");
  });

  it("starts every message with a word and never embeds escaped quotes", () => {
    const messages = [
      ["n1", "--limit", "x"],
      ["n1", "--full=yes"],
      ["n1", "--sort", "random"],
      ["n1", "--fields", "id,,title"],
      ["n1", "--limit"],
      ["n1", "--limit", "2", "--limit", "3"],
      ["n1", "n2"],
      ["n1", "--body", "x"],
    ].map((argv) => usageError(() => parseArgs(spec, argv)).message);
    for (const message of messages) {
      expect(message, message).toMatch(/^[a-z]/);
      expect(message, message).not.toContain('"');
    }
    expect(messages[2]).toBe("flag --sort does not accept random");
    expect(messages[6]).toBe("demo takes at most 1 argument (got n2)");
  });

  it("suggests the closest choice for a positional", () => {
    const setup: CommandSpec = {
      ...spec,
      name: "setup",
      positionals: [{ name: "<target>", description: "", required: false, choices: ["hooks", "skill"] }],
    };
    const error = usageError(() => parseArgs(setup, ["skil"]));
    expect(error.message).toBe("target does not accept skil (did you mean skill?)");
    expect(error.suggestions).toEqual(["overnote-axi setup skill", "valid values: hooks, skill", "overnote-axi setup [<target>] [flags]"]);
  });

  it("rejects short flags", () => {
    usageError(() => parseArgs(spec, ["n1", "-h"]));
  });

  it("points renamed flags at their replacement", () => {
    expect(usageError(() => parseArgs(spec, ["n1", "--body", "x"])).suggestions).toEqual(["Use --content instead"]);
  });

  it("validates values", () => {
    usageError(() => parseArgs(spec, ["n1", "--limit", "x"]));
    usageError(() => parseArgs(spec, ["n1", "--limit", "11"]));
    usageError(() => parseArgs(spec, ["n1", "--full=yes"]));
    usageError(() => parseArgs(spec, ["n1", "--sort", "random"]));
    usageError(() => parseArgs(spec, ["n1", "--fields", "id,,title"]));
    usageError(() => parseArgs(spec, ["n1", "--fields", "body"]));
    usageError(() => parseArgs(spec, ["n1", "--limit"]));
    usageError(() => parseArgs(spec, ["n1", "--limit", "2", "--limit", "3"]));
  });

  it("names the fix and the command's help for every bad value", () => {
    // Regression: number errors used to print no help lines at all (found by the e2e run).
    const fix = ["pass --limit <n> as a whole number from 1 to 10", "overnote-axi demo --help"];
    expect(usageError(() => parseArgs(spec, ["n1", "--limit", "x"])).suggestions).toEqual(fix);
    expect(usageError(() => parseArgs(spec, ["n1", "--limit", "0"])).suggestions).toEqual(fix);
    expect(usageError(() => parseArgs(spec, ["n1", "--limit", "11"])).suggestions).toEqual(fix);
    expect(usageError(() => parseArgs(spec, ["n1", "--sort", "random"])).suggestions).toEqual([
      "valid values: updated, created",
      "overnote-axi demo --help",
    ]);
    expect(usageError(() => parseArgs(spec, ["n1", "--fields", "body"])).suggestions.at(-1)).toBe("overnote-axi demo --help");
    expect(usageError(() => parseArgs(spec, ["n1", "--fields", "id,"])).suggestions.at(-1)).toBe("overnote-axi demo --help");
  });

  it("states one sided bounds and the declared default", () => {
    const bounded: CommandSpec = {
      ...spec,
      flags: [
        { name: "limit", type: "number", value: "<n>", min: 0, default: "50", description: "Rows" },
        { name: "steps", type: "number", value: "<n>", max: 9, description: "Steps" },
        { name: "at", type: "number", description: "Any whole number" },
      ],
    };
    expect(usageError(() => parseArgs(bounded, ["n1", "--limit", "-1"])).suggestions[0]).toBe(
      "pass --limit <n> as a whole number of at least 0 (default 50)",
    );
    expect(usageError(() => parseArgs(bounded, ["n1", "--steps", "10"])).suggestions[0]).toBe(
      "pass --steps <n> as a whole number of at most 9",
    );
    expect(usageError(() => parseArgs(bounded, ["n1", "--at", "1.5"])).suggestions[0]).toBe(
      "pass --at <n> as a whole number",
    );
  });

  it("checks positional arity", () => {
    usageError(() => parseArgs(spec, []));
    usageError(() => parseArgs(spec, ["a", "b"]));
  });
});

describe("editDistance and closest", () => {
  it("counts insertions, deletions, and substitutions", () => {
    expect(editDistance("lsit", "list")).toBe(2);
    expect(editDistance("serch", "search")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  it("returns the nearest candidate within 2 edits, else null", () => {
    expect(closest("lsit", ["home", "list", "links"])).toBe("list");
    expect(closest("--ful", ["--full", "--fields"])).toBe("--full");
    expect(closest("READ", ["read"])).toBe("read");
    expect(closest("xyzzy", ["home", "list"])).toBeNull();
  });
});

describe("help", () => {
  it("detects --help only before --", () => {
    expect(wantsHelp(["x", "--help"])).toBe(true);
    expect(wantsHelp(["--", "--help"])).toBe(false);
  });

  it("renders usage, args, flags and examples from the spec", () => {
    const help = renderCommandHelp(spec, "Demo command");
    expect(help).toContain("usage: overnote-axi demo <note> [flags]");
    expect(help).toContain("--limit <n>");
    expect(help).toContain("--help");
    expect(help).toContain("examples[1]:");
  });
});

describe("rebuildInvocation", () => {
  const spec: CommandSpec = {
    name: "list",
    positionals: [],
    flags: [
      { name: "limit", type: "number", description: "" },
      { name: "offset", type: "number", description: "" },
      { name: "pinned", type: "boolean", description: "" },
      { name: "sort", type: "string", description: "" },
      { name: "fields", type: "list", description: "" },
    ],
    examples: [],
    run: async () => ({ output: "" }),
  };

  it("carries every current flag forward and replaces only the changed one", () => {
    const args = parseArgs(spec, ["--sort", "accessed", "--fields", "id,title,accessed", "--pinned"]);
    expect(rebuildInvocation(spec, args, { offset: 50 })).toBe(
      "overnote-axi list --offset 50 --pinned --sort accessed --fields id,title,accessed",
    );
  });

  it("removes a flag set to null and quotes values that need it", () => {
    const search: CommandSpec = { ...spec, name: "search", positionals: [{ name: "<query>", description: "", required: true }] };
    const args = parseArgs(search, ['weekly "sync"', "--limit", "5"]);
    expect(rebuildInvocation(search, args, { limit: null })).toBe('overnote-axi search "weekly \\"sync\\""');
  });
});
