import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { createContext } from "../../src/context.js";
import { repoSkill } from "../../src/integrations/skill.js";
import { tempHome, type TempHome } from "../fixtures/temp-home.js";

let temp: TempHome;

beforeEach(() => {
  temp = tempHome();
});

afterEach(() => temp.remove());

async function run(
  argv: string[],
  binPath = temp.binPath,
  env: Record<string, string> = temp.env,
): Promise<{ code: number; out: string }> {
  let out = "";
  const context = createContext({ env, home: temp.home, uid: 501, binPath });
  const code = await main({ argv: ["setup", ...argv], stdout: { write: (chunk: string) => (out += chunk) }, context });
  return { code, out };
}

function agentDirs(...agents: ("claude" | "codex" | "opencode")[]): void {
  const dirs = { claude: path.join(temp.home, ".claude"), codex: temp.codexHome, opencode: path.join(temp.xdgConfigHome, "opencode") };
  for (const agent of agents) mkdirSync(dirs[agent], { recursive: true });
}

const settings = () => path.join(temp.home, ".claude", "settings.json");

describe("setup hooks", () => {
  it("reports a definitive empty state when no agent is installed, and writes nothing", async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "setup:",
        "  target: hooks",
        "  agents: 0 found (looked for ~/.claude ~/.codex ~/.config/opencode)",
        "help[2]:",
        "  overnote-axi setup --agent claude",
        "  overnote-axi setup skill",
        "",
      ].join("\n"),
    );
    expect(existsSync(path.join(temp.home, ".claude"))).toBe(false);
  });

  it("names the directories it actually checked in the empty state", async () => {
    const codexHome = path.join(temp.root, "elsewhere", "codex");
    const xdg = path.join(temp.home, "xdg");
    const { out } = await run([], temp.binPath, { ...temp.env, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdg });
    expect(out).toContain(`  agents: 0 found (looked for ~/.claude ${codexHome} ~/xdg/opencode)\n`);
  });

  it("installs for every detected agent with the bare name when it is on PATH", async () => {
    agentDirs("claude", "codex", "opencode");
    temp.linkOnPath();
    const { code, out } = await run(["hooks"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "setup:",
        "  target: hooks",
        "results[3]{agent,file,change}:",
        "  claude,~/.claude/settings.json,installed",
        "  codex,~/.codex/hooks.json,installed",
        "  opencode,~/.config/opencode/plugins/overnote-axi.js,installed",
        "help[3]:",
        "  Start a new agent session to see your notes at session start",
        "  Codex runs the hook only after you trust it: open Codex, run /hooks, and trust the overnote-axi hook",
        "  overnote-axi setup --uninstall",
        "",
      ].join("\n"),
    );
    expect(readFileSync(settings(), "utf8")).toContain('"command": "overnote-axi home --limit 3 --pinned-limit 3"');
  });

  it("tells the user to trust the hook in Codex only when the codex row was installed or updated", async () => {
    const trust = "Codex runs the hook only after you trust it";
    agentDirs("claude", "codex");
    expect((await run([])).out).toContain(trust);
    expect((await run([])).out).not.toContain(trust);
    temp.linkOnPath();
    const moved = await run(["--agent", "codex"]);
    expect(moved.out).toContain("codex,~/.codex/hooks.json,updated");
    expect(moved.out).toContain(trust);
    const claudeOnly = await run(["--agent", "claude"]);
    expect(claudeOnly.out).toContain("claude,~/.claude/settings.json,updated");
    expect(claudeOnly.out).not.toContain(trust);
    expect((await run(["--uninstall"])).out).not.toContain(trust);
  });

  it("is unchanged on a second run, with no hints", async () => {
    agentDirs("claude");
    await run([]);
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe(["setup:", "  target: hooks", "results[1]{agent,file,change}:", "  claude,~/.claude/settings.json,unchanged", ""].join("\n"));
  });

  it("runs node with the real script path when the bare name is not on PATH", async () => {
    agentDirs("claude");
    await run([]);
    const settingsText = readFileSync(settings(), "utf8");
    expect(JSON.parse(settingsText).hooks.SessionStart[0].hooks[0].command).toBe(
      `"${process.execPath}" "${realpathSync(temp.binPath)}" home --limit 3 --pinned-limit 3`,
    );
  });

  it("--agent narrows the targets and creates a missing config directory", async () => {
    agentDirs("codex");
    const { out } = await run(["--agent", "claude"]);
    expect(out).toContain("results[1]{agent,file,change}:\n  claude,~/.claude/settings.json,installed");
    expect(existsSync(path.join(temp.codexHome, "hooks.json"))).toBe(false);
  });

  it("rejects an unknown agent as a usage error", async () => {
    const { code, out } = await run(["--agent", "cursor"]);
    expect(code).toBe(2);
    expect(out).toContain("code: VALIDATION_ERROR");
  });

  it("suggests the closest agent with the corrected invocation first", async () => {
    const { code, out } = await run(["--agent", "codex,claud"]);
    expect(code).toBe(2);
    expect(out).toContain("error: flag --agent does not accept claud (did you mean claude?)\n");
    expect(out).toContain("help[3]:\n  overnote-axi setup --agent codex,claude\n  valid values: claude, codex, opencode\n");
  });

  it("exits 1 when an agent fails, shows code and reason, still applies the others, and hints a retry", async () => {
    agentDirs("claude", "opencode");
    writeFileSync(settings(), "{ broken");
    const { code, out } = await run([]);
    expect(code).toBe(1);
    expect(out).toBe(
      [
        "setup:",
        "  target: hooks",
        "results[2]{agent,file,change,code,reason}:",
        '  claude,~/.claude/settings.json,error,IO_ERROR,"settings.json is not valid JSON; fix it by hand, then run setup again"',
        '  opencode,~/.config/opencode/plugins/overnote-axi.js,installed,"",""',
        "help[1]:",
        "  overnote-axi setup --agent claude",
        "",
      ].join("\n"),
    );
    expect(readFileSync(settings(), "utf8")).toBe("{ broken");
  });

  it("refuses to register a hook from a TypeScript dev run", async () => {
    agentDirs("claude");
    const { code, out } = await run([], "/repo/bin/overnote-axi.ts");
    expect(code).toBe(2);
    expect(out).toContain("setup must run from the built CLI, not /repo/bin/overnote-axi.ts");
    expect(out).toContain("npm run build");
    expect(existsSync(settings())).toBe(false);
  });

  it("--uninstall removes from every agent, reports absent ones, and creates nothing", async () => {
    agentDirs("claude");
    await run([]);
    const { code, out } = await run(["--uninstall"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "setup:",
        "  target: hooks",
        "results[3]{agent,file,change}:",
        "  claude,~/.claude/settings.json,removed",
        "  codex,~/.codex/hooks.json,absent",
        "  opencode,~/.config/opencode/plugins/overnote-axi.js,absent",
        "",
      ].join("\n"),
    );
    // Only our hook was in the file setup created, so no `{}` is left behind.
    expect(existsSync(settings())).toBe(false);
    expect(existsSync(temp.codexHome)).toBe(false);
  });

  it("--uninstall skips an OpenCode plugin it did not write, with a note and exit 0", async () => {
    agentDirs("claude");
    await run([]);
    const plugin = path.join(temp.xdgConfigHome, "opencode", "plugins", "overnote-axi.js");
    mkdirSync(path.dirname(plugin), { recursive: true });
    writeFileSync(plugin, "export const Mine = async () => ({});\n");
    const { code, out } = await run(["--uninstall"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "setup:",
        "  target: hooks",
        "results[3]{agent,file,change,reason}:",
        '  claude,~/.claude/settings.json,removed,""',
        '  codex,~/.codex/hooks.json,absent,""',
        '  opencode,~/.config/opencode/plugins/overnote-axi.js,skipped,"not written by setup, so it is left alone"',
        "",
      ].join("\n"),
    );
    expect(readFileSync(plugin, "utf8")).toBe("export const Mine = async () => ({});\n");
  });

  it("--uninstall works from a dev run, since it writes no command", async () => {
    const { code } = await run(["--uninstall"], "/repo/bin/overnote-axi.ts");
    expect(code).toBe(0);
  });
});

describe("setup skill", () => {
  const skillPath = () => path.join(temp.home, ".claude", "skills", "overnote-axi", "SKILL.md");

  it("installs the skill with the resolved command", async () => {
    temp.linkOnPath();
    const { code, out } = await run(["skill"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "setup:",
        "  target: skill",
        "results[1]{agent,file,change}:",
        "  claude,~/.claude/skills/overnote-axi/SKILL.md,installed",
        "help[1]:",
        "  Start a new Claude Code session, then use /overnote-axi",
        "",
      ].join("\n"),
    );
    // On PATH, the installed copy is the committed skill: every command already runs.
    expect(readFileSync(skillPath(), "utf8")).toBe(repoSkill());
    expect((await run(["skill"])).out).toContain("claude,~/.claude/skills/overnote-axi/SKILL.md,unchanged\n");
  });

  it("states node and the script path once in the installed copy when not on PATH", async () => {
    await run(["skill"]);
    const installed = readFileSync(skillPath(), "utf8");
    const command = `"${process.execPath}" "${realpathSync(temp.binPath)}"`;
    expect(installed).toContain(`wherever this skill says \`overnote-axi\`, run ${command} instead.`);
    expect(installed.split(command).length - 1).toBe(1);
  });

  it("updates a copy installed from an older command", async () => {
    mkdirSync(path.dirname(skillPath()), { recursive: true });
    writeFileSync(skillPath(), repoSkill());
    // binDir holds no overnote-axi, so the command is now node plus the script path.
    expect((await run(["skill"])).out).toContain("claude,~/.claude/skills/overnote-axi/SKILL.md,updated\n");
  });

  it("leaves a hand written SKILL.md alone and exits 1", async () => {
    mkdirSync(path.dirname(skillPath()), { recursive: true });
    writeFileSync(skillPath(), "# mine\n");
    const { code, out } = await run(["skill"]);
    expect(code).toBe(1);
    expect(out).toContain("results[1]{agent,file,change,code,reason}:\n  claude,~/.claude/skills/overnote-axi/SKILL.md,error,IO_ERROR,");
    expect(out).toContain("help[1]:\n  overnote-axi setup skill\n");
    expect(readFileSync(skillPath(), "utf8")).toBe("# mine\n");
  });

  it("is a usage error for an agent other than claude, pointing at the alternatives", async () => {
    const { code, out } = await run(["skill", "--agent", "codex"]);
    expect(code).toBe(2);
    expect(out).toContain("setup skill installs for Claude Code only (--agent claude)");
    expect(out).toContain("npx skills add WesleyBLDC/overnote-axi --skill overnote-axi");
    expect(out).toContain("overnote-axi setup --agent codex");
    expect(existsSync(skillPath())).toBe(false);
  });

  it("accepts --agent claude", async () => {
    expect((await run(["skill", "--agent", "claude"])).code).toBe(0);
  });

  it("refuses to install from a TypeScript dev run", async () => {
    const { code } = await run(["skill"], "/repo/bin/overnote-axi.ts");
    expect(code).toBe(2);
    expect(existsSync(skillPath())).toBe(false);
  });

  it("--uninstall removes it, then reports absent", async () => {
    await run(["skill"]);
    expect((await run(["skill", "--uninstall"])).out).toBe(
      ["setup:", "  target: skill", "results[1]{agent,file,change}:", "  claude,~/.claude/skills/overnote-axi/SKILL.md,removed", ""].join("\n"),
    );
    expect(existsSync(skillPath())).toBe(false);
    expect((await run(["skill", "--uninstall"])).out).toContain(",absent\n");
  });
});
