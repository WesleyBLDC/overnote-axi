import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AxiError } from "../../src/errors.js";
import {
  detectAgents,
  hookCommand,
  hookCommandLine,
  hookLocations,
  hookTarget,
  installHooks,
  isOurHookCommand,
  OPENCODE_MARKER,
  removeSessionStartHook,
  renderProgram,
  resolveProgram,
  uninstallHooks,
  upsertSessionStartHook,
  type HookEnv,
  type HookLocations,
} from "../../src/integrations/hooks.js";
import { tempHome, type TempHome } from "../fixtures/temp-home.js";

let temp: TempHome;
let locations: HookLocations;
let env: HookEnv;

beforeEach(() => {
  temp = tempHome();
  locations = hookLocations(temp.env, temp.home);
  env = { ...locations, program: ["overnote-axi"] };
});

afterEach(() => temp.remove());

const COMMAND = "overnote-axi home --limit 3 --pinned-limit 3";
const ENTRY = { matcher: "", hooks: [{ type: "command", command: COMMAND, timeout: 10 }] };

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("hookLocations", () => {
  it("uses CODEX_HOME and XDG_CONFIG_HOME when set", () => {
    expect(hookLocations({ CODEX_HOME: "/x/codex", XDG_CONFIG_HOME: "/x/xdg" }, "/h")).toEqual({
      home: "/h",
      codexHome: "/x/codex",
      xdgConfigHome: "/x/xdg",
    });
  });

  it("falls back to the home defaults when unset or empty", () => {
    expect(hookLocations({ CODEX_HOME: "" }, "/h")).toEqual({ home: "/h", codexHome: "/h/.codex", xdgConfigHome: "/h/.config" });
  });
});

describe("detectAgents", () => {
  it("finds no agent in an empty home", () => {
    expect(detectAgents(locations)).toEqual([]);
  });

  it("finds each agent whose config directory exists, in report order", () => {
    mkdirSync(path.join(temp.xdgConfigHome, "opencode"), { recursive: true });
    mkdirSync(path.join(temp.home, ".claude"));
    expect(detectAgents(locations)).toEqual(["claude", "opencode"]);
    mkdirSync(temp.codexHome);
    expect(detectAgents(locations)).toEqual(["claude", "codex", "opencode"]);
  });

  it("ignores a regular file where a config directory would be", () => {
    writeFileSync(path.join(temp.home, ".claude"), "");
    expect(detectAgents(locations)).toEqual([]);
  });
});

describe("Claude Code settings.json", () => {
  const file = () => hookTarget(locations, "claude").file;

  it("creates the file with one SessionStart entry", () => {
    expect(installHooks(env, ["claude"])).toEqual([{ agent: "claude", file: file(), change: "installed" }]);
    expect(readJson(file())).toEqual({ hooks: { SessionStart: [ENTRY] } });
    expect(readFileSync(file(), "utf8").endsWith("}\n")).toBe(true);
  });

  it("is unchanged on a repeat install and leaves the file as it was", () => {
    installHooks(env, ["claude"]);
    const compact = JSON.stringify(readJson(file()));
    writeFileSync(file(), compact);
    expect(installHooks(env, ["claude"])[0]!.change).toBe("unchanged");
    expect(readFileSync(file(), "utf8")).toBe(compact);
  });

  it("keeps other keys and hooks in order and adds its entry last", () => {
    const other = { matcher: "startup", hooks: [{ type: "command", command: "other-tool home" }] };
    write(file(), JSON.stringify({ model: "opus", hooks: { PreToolUse: [], SessionStart: [other] }, z: 1 }));
    expect(installHooks(env, ["claude"])[0]!.change).toBe("installed");
    const text = readFileSync(file(), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["model", "hooks", "z"]);
    expect(readJson(file())).toEqual({ model: "opus", hooks: { PreToolUse: [], SessionStart: [other, ENTRY] }, z: 1 });
  });

  it("repairs a moved binary or a changed timeout in place", () => {
    const stale = { matcher: "", hooks: [{ type: "command", command: '"/old/node" "/old/overnote-axi.js" home', timeout: 30 }] };
    write(file(), JSON.stringify({ hooks: { SessionStart: [stale] } }));
    expect(installHooks(env, ["claude"])[0]!.change).toBe("updated");
    expect(readJson(file())).toEqual({ hooks: { SessionStart: [ENTRY] } });
  });

  it("removes duplicate entries left by an older install", () => {
    const twice = { matcher: "", hooks: [{ type: "command", command: COMMAND, timeout: 10 }] };
    const shared = { matcher: "", hooks: [{ type: "command", command: "keep-me" }, { type: "command", command: COMMAND, timeout: 10 }] };
    write(file(), JSON.stringify({ hooks: { SessionStart: [twice, shared] } }));
    expect(installHooks(env, ["claude"])[0]!.change).toBe("updated");
    expect(readJson(file())).toEqual({
      hooks: { SessionStart: [twice, { matcher: "", hooks: [{ type: "command", command: "keep-me" }] }] },
    });
  });

  it("treats an empty file as an empty object", () => {
    write(file(), "  \n");
    expect(installHooks(env, ["claude"])[0]!.change).toBe("installed");
    expect(readJson(file())).toEqual({ hooks: { SessionStart: [ENTRY] } });
  });

  it("leaves a file that does not parse alone and reports IO_ERROR", () => {
    write(file(), "{ not json");
    expect(installHooks(env, ["claude"])).toEqual([
      {
        agent: "claude",
        file: file(),
        change: "error",
        code: "IO_ERROR",
        reason: "settings.json is not valid JSON; fix it by hand, then run setup again",
      },
    ]);
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });

  it.each([
    ["[]", "does not hold a JSON object"],
    ['{"hooks": []}', "has a hooks value that is not an object"],
    ['{"hooks": {"SessionStart": {}}}', "has a hooks.SessionStart value that is not an array"],
  ])("refuses %s without writing", (text, problem) => {
    write(file(), text);
    const [row] = installHooks(env, ["claude"]);
    expect(row).toMatchObject({ change: "error", code: "IO_ERROR", reason: `settings.json ${problem}; fix it by hand, then run setup again` });
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  it("keeps the file mode", () => {
    write(file(), "{}");
    chmodSync(file(), 0o600);
    installHooks(env, ["claude"]);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked settings file to its target", () => {
    const target = path.join(temp.root, "dotfiles", "settings.json");
    write(target, '{"theme": "dark"}');
    mkdirSync(path.dirname(file()), { recursive: true });
    symlinkSync(target, file());
    installHooks(env, ["claude"]);
    expect(readJson(target)).toEqual({ theme: "dark", hooks: { SessionStart: [ENTRY] } });
    expect(realpathSync(file())).toBe(realpathSync(target));
  });

  it("uninstall removes only its entry and the SessionStart array it emptied", () => {
    installHooks(env, ["claude"]);
    const data = readJson(file()) as { hooks: Record<string, unknown> };
    data.hooks.Stop = [];
    writeFileSync(file(), JSON.stringify(data));
    expect(uninstallHooks(locations, ["claude"])).toEqual([{ agent: "claude", file: file(), change: "removed" }]);
    expect(readJson(file())).toEqual({ hooks: { Stop: [] } });
    expect(uninstallHooks(locations, ["claude"])[0]!.change).toBe("absent");
  });

  it("uninstall keeps other hooks in a shared group and groups the user left empty", () => {
    const shared = { matcher: "", hooks: [{ type: "command", command: "keep-me" }, { type: "command", command: COMMAND }] };
    const empty = { matcher: "x", hooks: [] };
    write(file(), JSON.stringify({ hooks: { SessionStart: [empty, shared] } }));
    expect(uninstallHooks(locations, ["claude"])[0]!.change).toBe("removed");
    expect(readJson(file())).toEqual({
      hooks: { SessionStart: [empty, { matcher: "", hooks: [{ type: "command", command: "keep-me" }] }] },
    });
  });

  it("leaves a user's own hook that only mentions the name alone on install and uninstall", () => {
    const mine = { matcher: "", hooks: [{ type: "command", command: "cd ~/code/GitHub/overnote-axi && npm run x" }] };
    write(file(), JSON.stringify({ hooks: { SessionStart: [mine] } }));
    expect(installHooks(env, ["claude"])[0]!.change).toBe("installed");
    expect(readJson(file())).toEqual({ hooks: { SessionStart: [mine, ENTRY] } });
    expect(uninstallHooks(locations, ["claude"])[0]!.change).toBe("removed");
    expect(readJson(file())).toEqual({ hooks: { SessionStart: [mine] } });
  });

  it("uninstall drops the hooks object it left empty and keeps other keys", () => {
    write(file(), JSON.stringify({ model: "opus" }));
    installHooks(env, ["claude"]);
    uninstallHooks(locations, ["claude"]);
    expect(readJson(file())).toEqual({ model: "opus" });
  });

  it("uninstall deletes a file left holding an empty object, but keeps a symlinked one as {}", () => {
    installHooks(env, ["claude"]);
    expect(uninstallHooks(locations, ["claude"])[0]!.change).toBe("removed");
    expect(existsSync(file())).toBe(false);

    const target = path.join(temp.root, "dotfiles", "settings.json");
    write(target, "{}");
    symlinkSync(target, file());
    installHooks(env, ["claude"]);
    expect(uninstallHooks(locations, ["claude"])[0]!.change).toBe("removed");
    expect(readJson(target)).toEqual({});
    expect(realpathSync(file())).toBe(realpathSync(target));
  });

  it("uninstall reports absent and creates nothing when the file is missing", () => {
    expect(uninstallHooks(locations, ["claude"])[0]!.change).toBe("absent");
    expect(existsSync(file())).toBe(false);
  });
});

describe("SessionStart helpers", () => {
  it("upsert reports what changed without writing", () => {
    const root: Record<string, unknown> = {};
    expect(upsertSessionStartHook("settings.json", root, COMMAND)).toBe("installed");
    expect(upsertSessionStartHook("settings.json", root, COMMAND)).toBe("unchanged");
    expect(upsertSessionStartHook("settings.json", root, "overnote-axi home")).toBe("updated");
  });

  it.each([
    [COMMAND, true],
    ['"/opt/homebrew/bin/node" "/opt/x/dist/overnote-axi.js" home --limit 3 --pinned-limit 3', true],
    ['"/old/node" "/old/overnote-axi.js" home', true],
    ["/usr/local/bin/overnote-axi home", true],
    ["overnote-axi home", true],
    ["cd ~/code/GitHub/overnote-axi && npm run x", false],
    ["cd ~/code/GitHub/overnote-axi && npm run home", false],
    ["overnote-axi-dev home", false],
    ["overnote-axi search home", false],
    ["other-tool home", false],
  ])("isOurHookCommand(%s) is %s", (command, ours) => {
    expect(isOurHookCommand(command)).toBe(ours);
  });

  it("remove is false when there is nothing of ours", () => {
    expect(removeSessionStartHook("settings.json", {})).toBe(false);
    expect(removeSessionStartHook("settings.json", { hooks: { SessionStart: [{ hooks: [{ command: "x" }] }] } })).toBe(false);
  });
});

describe("Codex", () => {
  const hooksFile = () => hookTarget(locations, "codex").file;
  const configFile = () => path.join(temp.codexHome, "config.toml");

  it("writes hooks.json and enables hooks in config.toml", () => {
    expect(installHooks(env, ["codex"])).toEqual([{ agent: "codex", file: hooksFile(), change: "installed" }]);
    expect(readJson(hooksFile())).toEqual({ hooks: { SessionStart: [ENTRY] } });
    expect(readFileSync(configFile(), "utf8")).toBe("[features]\nhooks = true\n");
    expect(installHooks(env, ["codex"])[0]!.change).toBe("unchanged");
  });

  it("reports updated when only config.toml needed the feature flag", () => {
    installHooks(env, ["codex"]);
    writeFileSync(configFile(), 'model = "o3"\n');
    expect(installHooks(env, ["codex"])[0]!.change).toBe("updated");
    expect(readFileSync(configFile(), "utf8")).toBe('model = "o3"\n\n[features]\nhooks = true\n');
  });

  it("touches neither file when hooks.json does not parse", () => {
    write(hooksFile(), "nope");
    write(configFile(), 'model = "o3"\n');
    expect(installHooks(env, ["codex"])[0]).toMatchObject({ change: "error", code: "IO_ERROR" });
    expect(readFileSync(configFile(), "utf8")).toBe('model = "o3"\n');
  });

  it("reports an inline features table as IO_ERROR without writing hooks.json", () => {
    write(configFile(), "features = { web_search = true }\n");
    expect(installHooks(env, ["codex"])[0]).toMatchObject({ change: "error", code: "IO_ERROR" });
    expect(existsSync(hooksFile())).toBe(false);
  });

  it("uninstall removes the hook but leaves hooks = true", () => {
    installHooks(env, ["codex"]);
    expect(uninstallHooks(locations, ["codex"])[0]!.change).toBe("removed");
    expect(existsSync(hooksFile())).toBe(false);
    expect(readFileSync(configFile(), "utf8")).toBe("[features]\nhooks = true\n");
  });

  it("restores hooks.json when the config.toml write fails, so the pair stays consistent", () => {
    const before = JSON.stringify({ hooks: { Stop: [] } });
    write(hooksFile(), before);
    write(configFile(), 'model = "o3"\n');
    // A directory where config.toml should be makes only that write fail; the plan reads it as
    // missing, so hooks.json is written first and must be rolled back.
    const config = configFile();
    rmSync(config);
    mkdirSync(config);
    expect(installHooks(env, ["codex"])[0]).toMatchObject({ change: "error", code: "IO_ERROR" });
    expect(readFileSync(hooksFile(), "utf8")).toBe(before);

    rmSync(hooksFile());
    expect(installHooks(env, ["codex"])[0]).toMatchObject({ change: "error" });
    expect(existsSync(hooksFile())).toBe(false);
  });
});

describe("OpenCode", () => {
  const file = () => hookTarget(locations, "opencode").file;

  it("writes the managed plugin with the marker first and the argv inlined", () => {
    expect(installHooks(env, ["opencode"])).toEqual([{ agent: "opencode", file: file(), change: "installed" }]);
    expect(file()).toBe(path.join(temp.xdgConfigHome, "opencode", "plugins", "overnote-axi.js"));
    const source = readFileSync(file(), "utf8");
    expect(source.split("\n")[0]).toBe(OPENCODE_MARKER);
    expect(source).toContain('const ARGV = ["overnote-axi","home","--limit","3","--pinned-limit","3"];');
    expect(source).toContain("const TIMEOUT_MS = 10000;");
    expect(installHooks(env, ["opencode"])[0]!.change).toBe("unchanged");
  });

  it("rewrites the managed plugin when the program moved", () => {
    installHooks(env, ["opencode"]);
    const moved = { ...env, program: ["/usr/local/bin/node", "/opt/x/dist/overnote-axi.js"] };
    expect(installHooks(moved, ["opencode"])[0]!.change).toBe("updated");
    expect(readFileSync(file(), "utf8")).toContain('const ARGV = ["/usr/local/bin/node","/opt/x/dist/overnote-axi.js","home"');
  });

  it("never overwrites or removes a plugin it did not write", () => {
    write(file(), "export const Mine = async () => ({});\n");
    expect(installHooks(env, ["opencode"])[0]).toMatchObject({
      change: "error",
      code: "IO_ERROR",
      reason: "plugins/overnote-axi.js exists and was not written by setup, so it is left alone; move it away, then run setup again",
    });
    expect(uninstallHooks(locations, ["opencode"])[0]).toEqual({
      agent: "opencode",
      file: file(),
      change: "skipped",
      reason: "not written by setup, so it is left alone",
    });
    expect(readFileSync(file(), "utf8")).toBe("export const Mine = async () => ({});\n");
  });

  it("uninstall keeps a plugins directory that holds other plugins", () => {
    installHooks(env, ["opencode"]);
    const other = path.join(path.dirname(file()), "mine.js");
    writeFileSync(other, "export {};\n");
    uninstallHooks(locations, ["opencode"]);
    expect(readFileSync(other, "utf8")).toBe("export {};\n");
  });

  it("uninstall removes the managed plugin and the plugins directory it emptied", () => {
    installHooks(env, ["opencode"]);
    expect(uninstallHooks(locations, ["opencode"])[0]!.change).toBe("removed");
    expect(existsSync(file())).toBe(false);
    expect(existsSync(path.dirname(file()))).toBe(false);
    expect(existsSync(path.join(temp.xdgConfigHome, "opencode"))).toBe(true);
    expect(uninstallHooks(locations, ["opencode"])[0]!.change).toBe("absent");
  });

  it("the plugin adds the home view once per session and nothing when the program fails", async () => {
    const pluginFile = file();
    const fakeBin = path.join(temp.root, "fake-home-view.sh");
    const runs = path.join(temp.root, "runs.log");
    writeFileSync(fakeBin, `#!/bin/sh\necho run >> "${runs}"\necho "bin: overnote-axi $*"\n`);
    chmodSync(fakeBin, 0o755);
    installHooks({ ...env, program: [fakeBin] }, ["opencode"]);
    const { OvernoteAxiPlugin } = (await import(pluginFile)) as {
      OvernoteAxiPlugin: () => Promise<Record<string, (input: unknown, output: { system: string[] }) => Promise<void>>>;
    };
    const hooks = await OvernoteAxiPlugin();
    const transform = hooks["experimental.chat.system.transform"]!;
    const output = { system: [] as string[] };
    await transform({ sessionID: "s1" }, output);
    expect(output.system).toEqual(["## Overnote notes (overnote-axi home)\nbin: overnote-axi home --limit 3 --pinned-limit 3"]);
    const again = { system: [] as string[] };
    await transform({ sessionID: "s1" }, again);
    expect(again.system).toEqual(output.system);
    expect(readFileSync(runs, "utf8")).toBe("run\n");

    // OpenCode also runs the transform for generations outside a chat session: add nothing.
    for (const input of [{}, { sessionID: "" }, undefined]) {
      const outside = { system: [] as string[] };
      await transform(input, outside);
      expect(outside.system).toEqual([]);
    }
    expect(readFileSync(runs, "utf8")).toBe("run\n");

    const brokenXdg = path.join(temp.root, "broken-xdg");
    installHooks({ ...env, xdgConfigHome: brokenXdg, program: [path.join(temp.root, "missing")] }, ["opencode"]);
    const broken = (await import(hookTarget({ ...locations, xdgConfigHome: brokenXdg }, "opencode").file)) as {
      OvernoteAxiPlugin: () => Promise<Record<string, (input: unknown, output: { system: string[] }) => Promise<void>>>;
    };
    const none = { system: [] as string[] };
    await (await broken.OvernoteAxiPlugin())["experimental.chat.system.transform"]!({ sessionID: "s1" }, none);
    expect(none.system).toEqual([]);
  });
});

describe("per agent results", () => {
  it("reports each agent in order, so one failure does not hide the others", () => {
    write(hookTarget(locations, "codex").file, "broken");
    const results = installHooks(env, ["opencode", "codex", "claude"]);
    expect(results.map((row) => [row.agent, row.change])).toEqual([
      ["claude", "installed"],
      ["codex", "error"],
      ["opencode", "installed"],
    ]);
  });
});

describe("resolveProgram", () => {
  const source = (overrides: Partial<{ binPath: string; execPath: string; pathEnv: string }> = {}) => ({
    binPath: temp.binPath,
    execPath: "/opt/node/bin/node",
    pathEnv: temp.binDir,
    ...overrides,
  });

  it("uses node and the real script path when the bare name is not on PATH", () => {
    expect(resolveProgram(source())).toEqual(["/opt/node/bin/node", realpathSync(temp.binPath)]);
  });

  it("uses the bare name when PATH resolves it to the same file", () => {
    temp.linkOnPath();
    expect(resolveProgram(source())).toEqual(["overnote-axi"]);
  });

  it("accepts an installed bin symlink that resolves to dist/overnote-axi.js", () => {
    const link = temp.linkOnPath();
    expect(resolveProgram(source({ binPath: link }))).toEqual(["overnote-axi"]);
  });

  it("ignores a different overnote-axi earlier on PATH", () => {
    const other = path.join(temp.root, "other", "dist", "overnote-axi.js");
    write(other, "");
    chmodSync(other, 0o755);
    temp.linkOnPath(other);
    expect(resolveProgram(source())).toEqual(["/opt/node/bin/node", realpathSync(temp.binPath)]);
  });

  describe("the node it runs", () => {
    // A Homebrew style install: the running node is a versioned Cellar path, and PATH has a
    // stable symlink to it.
    const cellarNode = () => {
      const node = path.join(temp.root, "Cellar", "node", "24.22.0", "bin", "node");
      write(node, "");
      chmodSync(node, 0o755);
      return node;
    };

    it("prefers the node on PATH when it is the same real file as execPath", () => {
      const node = cellarNode();
      const stable = path.join(temp.binDir, "node");
      symlinkSync(node, stable);
      expect(resolveProgram(source({ execPath: node }))).toEqual([stable, realpathSync(temp.binPath)]);
    });

    it("keeps execPath when the node on PATH is a different file", () => {
      const node = cellarNode();
      const other = path.join(temp.binDir, "node");
      write(other, "");
      chmodSync(other, 0o755);
      expect(resolveProgram(source({ execPath: node }))[0]).toBe(node);
    });

    it("keeps execPath when no node is on PATH", () => {
      const node = cellarNode();
      expect(resolveProgram(source({ execPath: node }))[0]).toBe(node);
    });
  });

  it("skips relative and empty PATH entries", () => {
    expect(resolveProgram(source({ pathEnv: `:bin:${temp.root}` }))[0]).toBe("/opt/node/bin/node");
  });

  it.each([
    ["a TypeScript entry", "/repo/bin/overnote-axi.ts"],
    ["a missing file", "/nowhere/dist/overnote-axi.js"],
  ])("refuses %s with VALIDATION_ERROR", (_label, binPath) => {
    expect(() => resolveProgram(source({ binPath }))).toThrow(AxiError);
    try {
      resolveProgram(source({ binPath }));
    } catch (error) {
      expect((error as AxiError).code).toBe("VALIDATION_ERROR");
      expect((error as AxiError).suggestions).toEqual(["npm run build", "node dist/overnote-axi.js setup"]);
    }
  });

  it("refuses a script that is not dist/overnote-axi.js", () => {
    const elsewhere = path.join(temp.root, "src", "overnote-axi.js");
    write(elsewhere, "");
    expect(() => resolveProgram(source({ binPath: elsewhere }))).toThrow(/setup must run from the built CLI/);
  });
});

describe("renderProgram and hookCommand", () => {
  it("keeps the bare name unquoted", () => {
    expect(renderProgram(["overnote-axi"])).toBe("overnote-axi");
    expect(hookCommandLine(["overnote-axi"])).toBe(COMMAND);
  });

  it("quotes absolute paths and escapes shell specials", () => {
    expect(renderProgram(["/My Apps/node", '/a"b/$x`y\\z.js'])).toBe('"/My Apps/node" "/a\\"b/\\$x\\`y\\\\z.js"');
  });

  it("renders the resolved program", () => {
    expect(hookCommand({ binPath: temp.binPath, execPath: "/n/node", pathEnv: "" })).toBe(`"/n/node" "${realpathSync(temp.binPath)}"`);
  });
});
