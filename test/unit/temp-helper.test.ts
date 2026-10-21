import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_HELPER_BIN, HELPER_MISSING, helperBinary, startTempHelper } from "../fixtures/temp-helper.js";

describe("temp helper fixture", () => {
  let dir: string;
  const saved = process.env.OVERNOTE_HELPER_BIN;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "overnote-axi-bin-"));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.OVERNOTE_HELPER_BIN;
    else process.env.OVERNOTE_HELPER_BIN = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  function script(name: string, body: string, mode = 0o755): string {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, mode);
    return file;
  }

  it("finds the binary from OVERNOTE_HELPER_BIN, else the Overnote checkout", () => {
    const bin = script("helper", "exit 0");
    expect(helperBinary({ OVERNOTE_HELPER_BIN: bin })).toBe(bin);
    expect(DEFAULT_HELPER_BIN).toMatch(/\.overnote\/helper\/\.build\/release\/OvernoteHelper$/);
    expect([DEFAULT_HELPER_BIN, null]).toContain(helperBinary({}));
  });

  it("reports a missing or non executable binary as null", () => {
    expect(helperBinary({ OVERNOTE_HELPER_BIN: path.join(dir, "missing") })).toBeNull();
    expect(helperBinary({ OVERNOTE_HELPER_BIN: script("plain", "exit 0", 0o644) })).toBeNull();
    expect(helperBinary({ OVERNOTE_HELPER_BIN: dir })).toBeNull();
  });

  it("refuses to start without a binary", async () => {
    process.env.OVERNOTE_HELPER_BIN = path.join(dir, "missing");
    await expect(startTempHelper()).rejects.toThrow(HELPER_MISSING);
  });

  it("fails with the helper's stderr and removes its temp dir when the helper exits at startup", async () => {
    process.env.OVERNOTE_HELPER_BIN = script("broken", "echo 'cannot open database' >&2\nexit 3");
    const error = await startTempHelper().then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toMatch(/did not start \(exit 3\): cannot open database/);
    const root = /in (\/\S+onx-\S+) did not start/.exec(error?.message ?? "")?.[1];
    expect(root).toBeDefined();
    expect(existsSync(root!)).toBe(false);
  });
});
