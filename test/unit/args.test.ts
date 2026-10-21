import { describe, expect, it } from "vitest";

import { parseArgs, rebuildInvocation, renderCommandHelp, wantsHelp } from "../../src/args.js";
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
    expect(error.message).toBe("unknown flag --limt for demo");
    expect(error.suggestions[0]).toContain("--limit");
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

  it("checks positional arity", () => {
    usageError(() => parseArgs(spec, []));
    usageError(() => parseArgs(spec, ["a", "b"]));
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
