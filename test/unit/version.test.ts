import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { nodeTooOld, VERSION } from "../../src/version.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("refuses Node below 22.16 and accepts 22.16 and newer", () => {
    for (const v of ["21.9.0", "22.5.0", "22.12.0", "22.15.1"]) expect(nodeTooOld(v), v).toBe(true);
    for (const v of ["22.16.0", "22.16.1", "22.20.0", "23.0.0", "24.1.0"]) expect(nodeTooOld(v), v).toBe(false);
  });
});
