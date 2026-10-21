import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SUPPORT_SUBPATH,
  defaultRuntimeDir,
  isTrustedRuntimeDir,
  isTrustedSocket,
  resolvePaths,
} from "../../src/config/paths.js";
import { assertIsolated } from "../fixtures/guard.js";

describe("resolvePaths", () => {
  it("uses the app defaults without overrides", () => {
    expect(resolvePaths({ env: {}, home: "/Users/someone", uid: 501 })).toEqual({
      supportDir: `/Users/someone/${DEFAULT_SUPPORT_SUBPATH}`,
      database: `/Users/someone/${DEFAULT_SUPPORT_SUBPATH}/notes.sqlite`,
      runtimeDir: "/tmp/overnote-501",
      socket: "/tmp/overnote-501/helper.sock",
    });
    expect(defaultRuntimeDir(42)).toBe("/tmp/overnote-42");
  });

  it("honors OVERNOTE_SUPPORT_DIR and OVERNOTE_RUNTIME_DIR", () => {
    const paths = resolvePaths({
      env: { OVERNOTE_SUPPORT_DIR: "/tmp/x/support", OVERNOTE_RUNTIME_DIR: "/tmp/x/run" },
      home: "/Users/someone",
      uid: 501,
    });
    expect(paths).toEqual({
      supportDir: "/tmp/x/support",
      database: "/tmp/x/support/notes.sqlite",
      runtimeDir: "/tmp/x/run",
      socket: "/tmp/x/run/helper.sock",
    });
  });

  it("ignores blank overrides and resolves relative ones", () => {
    const paths = resolvePaths({ env: { OVERNOTE_SUPPORT_DIR: "  ", OVERNOTE_RUNTIME_DIR: "rel/run" }, home: "/h", uid: 7 });
    expect(paths.supportDir).toBe(`/h/${DEFAULT_SUPPORT_SUBPATH}`);
    expect(paths.runtimeDir).toBe(path.resolve("rel/run"));
  });

  it("follows the isolated test environment", () => {
    const paths = resolvePaths({ env: process.env, home: os.homedir(), uid: os.userInfo().uid });
    for (const value of Object.values(paths)) assertIsolated(value);
  });
});

describe("trust checks", () => {
  const uid = os.userInfo().uid;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/onx-trust-");
    assertIsolated(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("trusts only a private directory owned by the user", () => {
    const dir = path.join(root, "run");
    mkdirSync(dir, { mode: 0o700 });
    expect(isTrustedRuntimeDir(dir, uid)).toBe(true);
    expect(isTrustedRuntimeDir(dir, uid + 1)).toBe(false);
    chmodSync(dir, 0o750);
    expect(isTrustedRuntimeDir(dir, uid)).toBe(false);
    chmodSync(dir, 0o702);
    expect(isTrustedRuntimeDir(dir, uid)).toBe(false);
  });

  it("refuses a missing dir, a file, and a symlink to a good dir", () => {
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, "link");
    symlinkSync(real, link);
    const file = path.join(root, "file");
    writeFileSync(file, "");
    chmodSync(file, 0o600);
    expect(isTrustedRuntimeDir(path.join(root, "missing"), uid)).toBe(false);
    expect(isTrustedRuntimeDir(file, uid)).toBe(false);
    expect(isTrustedRuntimeDir(link, uid)).toBe(false);
  });

  it("trusts only a real socket owned by the user", async () => {
    const socket = path.join(root, "helper.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(isTrustedSocket(socket, uid)).toBe(true);
      expect(isTrustedSocket(socket, uid + 1)).toBe(false);
      const link = path.join(root, "link.sock");
      symlinkSync(socket, link);
      expect(isTrustedSocket(link, uid)).toBe(false);
      const file = path.join(root, "plain.sock");
      writeFileSync(file, "");
      expect(isTrustedSocket(file, uid)).toBe(false);
      expect(isTrustedSocket(path.join(root, "missing.sock"), uid)).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
