import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AxiError } from "../../src/errors.js";
import { HOME_HINTS, NOTE_REF_HELP, SAFETY, WORKFLOW } from "../../src/guidance.js";
import {
  buildSkill,
  commandsBlock,
  installSkill,
  repoSkill,
  SKILL_DESCRIPTION,
  SKILL_MARKER,
  skillFile,
  skillInput,
  uninstallSkill,
} from "../../src/integrations/skill.js";
import { COMMANDS } from "../../src/registry.js";
import { tempHome, type TempHome } from "../fixtures/temp-home.js";

const INSTALLED = '"/opt/node/bin/node" "/opt/overnote-axi/dist/overnote-axi.js"';

/** Lines outside fenced code blocks. */
function prose(markdown: string): string[] {
  let fenced = false;
  return markdown.split("\n").filter((line) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

describe("buildSkill", () => {
  const skill = repoSkill();

  it("starts with the frontmatter that makes it /overnote-axi", () => {
    const [open, name, description, close] = skill.split("\n");
    expect(open).toBe("---");
    expect(name).toBe("name: overnote-axi");
    expect(description).toBe(`description: ${JSON.stringify(SKILL_DESCRIPTION)}`);
    expect(close).toBe("---");
  });

  it("names the trigger intents in its description", () => {
    for (const intent of ["Overnote", "Raycast notes", "scratchpad", "quick note", "read", "search", "append", "checking off", "pin", "link", "delet"]) {
      expect(SKILL_DESCRIPTION).toContain(intent);
    }
  });

  it("carries the generated marker", () => {
    expect(skill).toContain(SKILL_MARKER);
  });

  it("lists every command with its help summary", () => {
    expect(commandsBlock().split("\n")).toHaveLength(COMMANDS.length);
    for (const entry of COMMANDS) expect(skill).toMatch(new RegExp(`^${entry.name} +${escape(entry.summary)}$`, "m"));
  });

  it("renders the shared guidance, so it follows the home view", () => {
    for (const hint of HOME_HINTS) expect(skill).toContain(`- \`${hint}\``);
    for (const line of [...WORKFLOW, ...SAFETY]) expect(skill).toContain(`- ${line}`);
    expect(skill).toContain(NOTE_REF_HELP.replace(/^<note>/, "`<note>`").replace("title:<exact title>", "`title:<exact title>`"));
  });

  it("says each thing once: one safety list, no separate workflow section", () => {
    expect(skill).not.toContain("## Workflow");
    expect(skill.match(/^## Safety rules$/gm)).toHaveLength(1);
    for (const line of SAFETY) expect(skill.split(line).length - 1, line).toBe(1);
    expect(skill.split("Use it whenever").length - 1).toBe(0);
  });

  it("puts every command in backticks in the guidance lists", () => {
    for (const line of [...WORKFLOW, ...SAFETY]) expect(line, line).not.toMatch(/(^|[^`])overnote-axi [a-z]/);
  });

  it("covers prepend, id suffixes, the current fallback, and no permanent hints", () => {
    expect(skill).toMatch(/`--prepend` inserts right after the title line/);
    expect(skill).toMatch(/`--top` puts the content above the title/);
    expect(skill).toMatch(/prefer the last 6 chars of the id/);
    expect(skill).toMatch(/current \(the note open in Overnote, else the newest note\)/);
    expect(skill).toMatch(/no hint ever offers it/);
  });

  it("follows input changes instead of hard coding them", () => {
    const custom = buildSkill({ ...skillInput(), homeHints: ["overnote-axi list"], workflow: ["Do one thing"], safety: ["Be safe."] });
    expect(custom).toContain("- `overnote-axi list`");
    expect(custom).toContain("- Do one thing.");
    expect(custom).toContain("- Be safe.");
    expect(custom).not.toContain(WORKFLOW[0]!);
  });

  it.each([
    ["where to start", "## Start here"],
    ["runnable examples", "## Examples"],
    ["the supported markdown subset", "## Supported markdown"],
    ["the formatting rules", "## Writing clean notes"],
    ["the safety rules", "## Safety rules"],
    ["the common errors", "## Common errors"],
  ])("teaches %s", (_label, heading) => {
    expect(skill).toContain(`\n${heading}\n`);
  });

  it("states the formatting rules, scoped to notes the agent maintains", () => {
    expect(skill).toMatch(/In a note the person wrote, follow its existing layout/);
    expect(skill).toMatch(/first line is the title/);
    expect(skill).toMatch(/`As of <Mon DD>\.` on the second line/);
    expect(skill).toMatch(/`update --prepend` also lands below the title/);
    expect(skill).toMatch(/dated section/);
    expect(skill).toMatch(/No tables or images/);
    expect(skill).toContain("https://github.com/WesleyBLDC/overnote#writing-clean-notes");
    expect(skill).not.toMatch(/Slack|chat app/);
    expect(skill).not.toMatch(/dashes as punctuation/);
  });

  it("states the write safety rules", () => {
    expect(skill).toMatch(/Append by default/);
    expect(skill).toMatch(/`edit` is block scoped/);
    expect(skill).toMatch(/`update --replace` or `delete` only when the user asks/);
    expect(skill).toMatch(/`--permanent`.*only when the user explicitly asked in this conversation/);
    expect(skill).toMatch(/`recover <id>` restores it/);
  });

  it("names each common error by its code", () => {
    expect(skill).toContain("- `STALE_WRITE`: the note changed since you read it;");
    expect(skill).toContain("- `AMBIGUOUS_NOTE` and `AMBIGUOUS_TEXT`: pick a full id");
  });

  it("gives every example a real command and flags it declares", async () => {
    const block = skill.slice(skill.indexOf("```sh\n") + 6, skill.indexOf("```", skill.indexOf("```sh\n") + 6));
    const lines = block.split("\n").filter((line) => line.startsWith("overnote-axi"));
    expect(lines.length).toBeGreaterThan(8);
    for (const line of lines) {
      const [, name = "home", ...rest] = line.split(" ");
      const entry = COMMANDS.find((candidate) => candidate.name === name);
      expect(entry, line).toBeDefined();
      const { command } = await entry!.load();
      const declared = new Set(command.flags.map((flag) => flag.name));
      for (const word of rest) if (word.startsWith("--")) expect(declared.has(word.slice(2)), `${line}: ${word}`).toBe(true);
    }
  });

  it("uses the bare name and the not on PATH fallback in the committed form", () => {
    expect(skill).toContain("If `command -v overnote-axi` fails, run `npm install -g .`");
    expect(skill).toContain("`node <overnote-axi repo>/dist/overnote-axi.js`");
  });

  it("never invokes the CLI through npx (the npm name is not published or owned)", () => {
    expect(skill).not.toMatch(/npx\s+(-y\s+)?overnote-axi/);
    expect(buildSkill(skillInput(INSTALLED))).not.toMatch(/npx/);
  });

  it("never uses dashes as punctuation in its prose", () => {
    for (const line of prose(skill)) {
      expect(line, line).not.toMatch(/[\u2013\u2014]/);
      expect(line.replace(/^\s*- /, ""), line).not.toMatch(/\s-\s/);
    }
  });

  it("states an installed command exactly once, as what overnote-axi stands for", () => {
    const installed = buildSkill(skillInput(INSTALLED));
    expect(installed).toContain(
      `This copy was installed by \`overnote-axi setup skill\`: wherever this skill says \`overnote-axi\`, run ${INSTALLED} instead.`,
    );
    expect(installed).not.toContain("command -v overnote-axi");
    expect(installed.split(INSTALLED).length - 1).toBe(1);
    // Everything else, the examples included, is the same as the committed copy.
    expect(installed.replace(/^This copy was installed.*$/m, "")).toBe(skill.replace(/^If `command -v overnote-axi` fails.*$/m, ""));
    expect(installed).toContain("- `overnote-axi read <id>`");
    expect(installed).toContain("Run `overnote-axi` first");
    expect(installed).toContain("# Overnote notes with overnote-axi");
    expect(installed).toContain("name: overnote-axi");
    expect(installed).toContain("overnote-axi reads, searches, creates");
  });

  it("ends with exactly one newline", () => {
    expect(skill.endsWith("\n")).toBe(true);
    expect(skill.endsWith("\n\n")).toBe(false);
  });
});

describe("installSkill and uninstallSkill", () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = tempHome();
  });
  afterEach(() => temp.remove());

  const content = () => buildSkill(skillInput(INSTALLED));

  it("installs to ~/.claude/skills/overnote-axi/SKILL.md, then reports unchanged", () => {
    const file = path.join(temp.home, ".claude", "skills", "overnote-axi", "SKILL.md");
    expect(skillFile(temp.home)).toBe(file);
    expect(installSkill(temp.home, content())).toEqual({ file, change: "installed" });
    expect(readFileSync(file, "utf8")).toBe(content());
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(installSkill(temp.home, content())).toEqual({ file, change: "unchanged" });
  });

  it("updates a managed copy that differs and keeps its mode", () => {
    installSkill(temp.home, repoSkill());
    chmodSync(skillFile(temp.home), 0o600);
    expect(installSkill(temp.home, content()).change).toBe("updated");
    expect(readFileSync(skillFile(temp.home), "utf8")).toBe(content());
    expect(statSync(skillFile(temp.home)).mode & 0o777).toBe(0o600);
  });

  it("never overwrites or removes a SKILL.md a person wrote", () => {
    const file = skillFile(temp.home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "# my own notes skill\n");
    for (const attempt of [() => installSkill(temp.home, content()), () => uninstallSkill(temp.home)]) {
      try {
        attempt();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AxiError);
        expect((error as AxiError).code).toBe("IO_ERROR");
      }
    }
    expect(readFileSync(file, "utf8")).toBe("# my own notes skill\n");
  });

  it("uninstall removes the file and its empty directory, then reports absent", () => {
    installSkill(temp.home, content());
    expect(uninstallSkill(temp.home)).toEqual({ file: skillFile(temp.home), change: "removed" });
    expect(existsSync(path.dirname(skillFile(temp.home)))).toBe(false);
    expect(existsSync(path.join(temp.home, ".claude", "skills"))).toBe(false);
    expect(existsSync(path.join(temp.home, ".claude"))).toBe(true);
    expect(uninstallSkill(temp.home)).toEqual({ file: skillFile(temp.home), change: "absent" });
  });

  it("uninstall keeps the skills directory when it holds other skills", () => {
    const other = path.join(temp.home, ".claude", "skills", "mine", "SKILL.md");
    mkdirSync(path.dirname(other), { recursive: true });
    writeFileSync(other, "# mine\n");
    installSkill(temp.home, content());
    uninstallSkill(temp.home);
    expect(existsSync(path.dirname(skillFile(temp.home)))).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("# mine\n");
  });

  it("uninstall keeps the directory when it holds other files", () => {
    installSkill(temp.home, content());
    const extra = path.join(path.dirname(skillFile(temp.home)), "notes.txt");
    writeFileSync(extra, "keep");
    uninstallSkill(temp.home);
    expect(readFileSync(extra, "utf8")).toBe("keep");
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
