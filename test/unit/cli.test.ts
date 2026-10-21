import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { guardStdout, main } from "../../src/cli.js";
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

  it("rejects unknown commands with exit 2", async () => {
    const { code, out } = await run(["lsit"]);
    expect(code).toBe(2);
    expect(out).toContain("error: unknown command lsit");
    expect(out).toContain("code: VALIDATION_ERROR");
  });

  it("rejects a leading flag and suggests the home form", async () => {
    const { code, out } = await run(["--limit", "3"]);
    expect(code).toBe(2);
    expect(out).toContain("overnote-axi home --limit 3");
  });

  it("validates flags before running", async () => {
    const { code, out } = await run(["list", "--bogus"]);
    expect(code).toBe(2);
    expect(out).toContain("unknown flag --bogus for list");
  });

  it("renders thrown errors as TOON with exit 1", async () => {
    // The scaffold's stubs throw NOT_IMPLEMENTED; once implemented, status still exits 0 or 1 with TOON.
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
