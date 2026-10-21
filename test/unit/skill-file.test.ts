import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CORE_REVISION } from "../../src/build-info.js";

describe("committed skill", () => {
  it("never invokes the CLI through npx (the npm name is not published or owned)", () => {
    const skill = readFileSync(new URL("../../skills/overnote-axi/SKILL.md", import.meta.url), "utf8");
    expect(skill).not.toMatch(/npx\s+(-y\s+)?overnote-axi/);
  });
});

describe("build info", () => {
  it("reports source when not bundled", () => {
    expect(CORE_REVISION).toBe("source");
  });
});
