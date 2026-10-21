import os from "node:os";

import { describe, expect, it } from "vitest";

import { createRuntimeContext } from "../../src/runtime.js";
import { assertIsolated, REAL_HOME, REAL_RUNTIME_DIR } from "../fixtures/guard.js";
import { fakeContext } from "../fixtures/fakes.js";

describe("test isolation", () => {
  it("points HOME and agent config away from the real home", () => {
    expect(os.homedir()).not.toBe(REAL_HOME);
    for (const name of ["HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "OVERNOTE_SUPPORT_DIR", "OVERNOTE_RUNTIME_DIR"]) {
      expect(() => assertIsolated(process.env[name]!, name)).not.toThrow();
    }
    expect(process.env.OVERNOTE_AXI_OPEN_CMD).toBe("/usr/bin/true");
  });

  it("refuses real locations", () => {
    expect(() => assertIsolated(`${REAL_HOME}/.claude/settings.json`)).toThrow(/Test isolation/);
    expect(() => assertIsolated(`${REAL_RUNTIME_DIR}/helper.sock`)).toThrow(/Test isolation/);
  });

  it("gives the runtime context the isolated home", () => {
    const context = createRuntimeContext();
    expect(context.home).toBe(process.env.HOME);
    expect(() => assertIsolated(context.home)).not.toThrow();
    context.close();
  });

  it("fake contexts record URLs instead of opening them", async () => {
    const { context, opened } = fakeContext();
    await context.openUrl("raycast://extensions/wesleybldc/overnote/open-notes");
    expect(opened).toEqual(["raycast://extensions/wesleybldc/overnote/open-notes"]);
  });
});
