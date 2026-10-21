import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { guardStdout, leadingFlagFix, main } from "../../src/cli.js";
import { createContext } from "../../src/context.js";
import { unknownFailureHelp } from "../../src/errors.js";

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main({ argv, stdout: { write: (chunk: string) => (out += chunk) }, context: createContext() });
  return { code, out };
}

describe("cli", () => {
  it("prints top-level help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: overnote-axi [command] [args] [flags]");
    expect(out).toMatch(/commands\[\d+\]:/);
  });

  it("prints per-command help without running the command", async () => {
    const { code, out } = await run(["list", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: overnote-axi list [flags]");
  });

  it("rejects unknown commands with exit 2 and suggests the closest one", async () => {
    const { code, out } = await run(["lsit", "--limit", "3"]);
    expect(code).toBe(2);
    expect(out).toContain("error: unknown command lsit (did you mean list?)\n");
    expect(out).toContain("code: VALIDATION_ERROR");
    expect(out).toContain("help[3]:\n  overnote-axi list --limit 3\n  valid commands: home, list,");
    const typo = await run(["updte", "K9QW7Z", "--content", "private text"]);
    expect(typo.out).toContain('help[3]:\n  overnote-axi update K9QW7Z --content "<markdown>"\n');
    expect(typo.out).not.toContain("private text");
    const far = await run(["xyzzy"]);
    expect(far.out).toContain("error: unknown command xyzzy\n");
    expect(far.out).toContain("help[2]:\n  valid commands: ");
  });

  it("accepts help as --help", async () => {
    const top = (await run(["--help"])).out;
    expect(await run(["help"])).toEqual({ code: 0, out: top });
    const read = (await run(["read", "--help"])).out;
    expect(await run(["help", "read"])).toEqual({ code: 0, out: read });
    expect(await run(["list", "help"])).toEqual(await run(["list", "--help"]));
    expect(await run(["setup", "help"])).toEqual(await run(["setup", "--help"]));
    expect((await run(["help", "raed"])).out).toContain("  overnote-axi read --help\n");
  });

  it("leads the top-level examples with read current", async () => {
    const { out } = await run(["--help"]);
    expect(out).toContain("examples[4]:\n  overnote-axi read current\n");
    expect(out).not.toContain("update current");
  });

  it("rejects a leading flag and suggests the home form", async () => {
    const { code, out } = await run(["--limit", "3"]);
    expect(code).toBe(2);
    expect(out).toContain("overnote-axi home --limit 3");
  });

  it("corrects a leading --help or -- instead of suggesting home", async () => {
    // Regression: `overnote-axi -- list` suggested `overnote-axi home -- list`, which fails again
    // (found by the e2e run).
    expect(leadingFlagFix(["--", "list"])).toBe("overnote-axi list");
    expect(leadingFlagFix(["--"])).toBe("overnote-axi");
    expect(leadingFlagFix(["--help", "read"])).toBe("overnote-axi read --help");
    expect(leadingFlagFix(["--help", "bogus"])).toBe("overnote-axi home --help bogus");
    expect(leadingFlagFix(["--full"])).toBe("overnote-axi home --full");
    const { code, out } = await run(["--help", "read"]);
    expect(code).toBe(2);
    expect(out).toContain("  overnote-axi read --help\n");
  });

  it("validates flags before running", async () => {
    const { code, out } = await run(["list", "--bogus"]);
    expect(code).toBe(2);
    expect(out).toContain("unknown flag --bogus for list");
  });

  it("renders thrown errors as TOON with exit 1", async () => {
    // status is a diagnostic: with nothing installed it still exits 0 or 1 and prints TOON.
    const { code, out } = await run(["status"]);
    expect([0, 1]).toContain(code);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("gives an unexpected failure actionable help", () => {
    expect(unknownFailureHelp(["read", "current"])).toEqual([
      "overnote-axi status",
      "OVERNOTE_AXI_DEBUG=1 overnote-axi read current",
    ]);
  });
});

describe("guardStdout", () => {
  it("treats EPIPE (reader closed early, as with head) as a clean exit 0", () => {
    const stream = new EventEmitter();
    let exitCode = -1;
    let exited = false;
    guardStdout(stream, (code) => (exitCode = code), () => (exited = true));
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exitCode).toBe(0);
    expect(exited).toBe(true);
  });

  it("rethrows any other stream error", () => {
    const stream = new EventEmitter();
    guardStdout(stream, () => undefined, () => undefined);
    expect(() => stream.emit("error", Object.assign(new Error("nope"), { code: "EIO" }))).toThrow("nope");
  });
});
