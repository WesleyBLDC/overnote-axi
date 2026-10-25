import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error plain ESM build script without type declarations
import { exportsName, locateOvernote, overnoteDir } from "../../scripts/overnote-dir.mjs";
import { assertIsolated } from "../fixtures/guard.js";

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "overnote-axi-dir-")));
  assertIsolated(dir, "fixture");
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  });
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A fake Overnote checkout whose core exports duplicateContent and whose packages/core is committed. */
function fakeOvernote(dir: string): void {
  write(path.join(dir, "packages/core/src/index.ts"), "export function duplicateContent() {}\n");
  mkdirSync(path.join(dir, "node_modules/@tiptap/core"), { recursive: true });
  write(path.join(dir, ".gitignore"), "node_modules\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

describe("locateOvernote", () => {
  it("finds the main checkout's sibling from inside a worktree, and OVERNOTE_DIR overrides it", () => {
    const parent = tempDir();
    const main = path.join(parent, "overnote-axi");
    mkdirSync(main);
    write(path.join(main, "a.txt"), "a");
    git(main, "init", "-q");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    const worktree = path.join(main, ".claude", "worktrees", "agent-x");
    git(main, "worktree", "add", "-q", worktree);

    expect(locateOvernote({ root: worktree, env: {} })).toBe(path.join(parent, "overnote"));
    expect(locateOvernote({ root: worktree, env: { OVERNOTE_DIR: "/somewhere/else" } })).toBe("/somewhere/else");
  });

  it("prefers ../overnote when it exists", () => {
    const parent = tempDir();
    mkdirSync(path.join(parent, "overnote"));
    mkdirSync(path.join(parent, "overnote-axi"));
    expect(locateOvernote({ root: path.join(parent, "overnote-axi"), env: {} })).toBe(path.join(parent, "overnote"));
  });
});

describe("overnoteDir dirty core warning", () => {
  it("stays quiet for a clean core and warns once for a dirty one, naming OVERNOTE_DIR", () => {
    const dir = tempDir();
    fakeOvernote(dir);
    const warnings: string[] = [];
    const env = { OVERNOTE_DIR: dir };

    expect(overnoteDir({ root: dir, env, warn: (line: string) => warnings.push(line) })).toBe(dir);
    expect(warnings).toEqual([]);

    write(path.join(dir, "packages/core/src/index.ts"), "export function duplicateContent() {}\n// edited\n");
    overnoteDir({ root: dir, env, warn: (line: string) => warnings.push(line) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(dir);
    expect(warnings[0]).toContain("OVERNOTE_DIR");

    warnings.length = 0;
    overnoteDir({ root: dir, env: { ...env, OVERNOTE_REQUIRE_CLEAN: "1" }, warn: (line: string) => warnings.push(line) });
    expect(warnings).toEqual([]);
  });
});

describe("exportsName", () => {
  it("counts export * from a .js specifier that names a .ts file", () => {
    const dir = tempDir();
    write(path.join(dir, "index.ts"), "export * from './content.js';\n");
    write(path.join(dir, "content.ts"), "export function duplicateContent() {}\n");
    expect(exportsName(path.join(dir, "index.ts"), "duplicateContent")).toBe(true);
  });

  it("does not treat a backtick inside a regex literal as a string, in either direction", () => {
    const dir = tempDir();
    // A real export after the regex still counts.
    write(path.join(dir, "real.ts"), "const tick = /`/;\nexport function duplicateContent() {}\nconst again = /`[a-z]/g;\n");
    expect(exportsName(path.join(dir, "real.ts"), "duplicateContent")).toBe(true);
    // A commented export between two such regexes is not swallowed into a fake string, so it stays a comment.
    write(path.join(dir, "fake.ts"), "const a = /`/;\n// export function duplicateContent() {}\nconst b = /`/;\n");
    expect(exportsName(path.join(dir, "fake.ts"), "duplicateContent")).toBe(false);
  });

  it("still ignores exports that only appear in comments", () => {
    const dir = tempDir();
    write(path.join(dir, "index.ts"), "// export function duplicateContent() {}\n/* export const duplicateContent = 1 */\n");
    expect(exportsName(path.join(dir, "index.ts"), "duplicateContent")).toBe(false);
  });
});
