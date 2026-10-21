import { describe, expect, it } from "vitest";

import { renderCommandHelp } from "../../src/args.js";
import { COMMANDS } from "../../src/registry.js";

describe("registry", () => {
  it("has unique names", () => {
    const names = COMMANDS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(COMMANDS.map((entry) => [entry.name, entry] as const))("%s loads a matching, documented spec", async (name, entry) => {
    const { command } = await entry.load();
    expect(command.name).toBe(name);
    expect(command.examples.length).toBeGreaterThanOrEqual(1);
    expect(command.examples.length).toBeLessThanOrEqual(3);
    for (const example of command.examples) expect(example).toContain(`overnote-axi ${name === "home" ? "" : name}`.trim());
    const flagNames = command.flags.map((flag) => flag.name);
    expect(new Set(flagNames).size).toBe(flagNames.length);
    expect(flagNames).not.toContain("help");
    expect(renderCommandHelp(command, entry.summary)).toContain(`usage: overnote-axi ${name}`);
  });

  it("keeps summaries free of dash punctuation", () => {
    for (const entry of COMMANDS) expect(entry.summary).not.toMatch(/ [-–—] /);
  });
});
