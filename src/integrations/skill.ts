/**
 * The overnote-axi Agent Skill (slice: integrations).
 *
 * `buildSkill()` renders skills/overnote-axi/SKILL.md from the same help text the CLI prints
 * (the top-level help's commands block and NOTE_REF_HELP), so the skill cannot drift;
 * scripts/build-skill.mjs writes it and `--check` fails on a stale copy.
 * `installSkill()` copies it to `~/.claude/skills/overnote-axi/SKILL.md` for `setup skill`.
 */
import { notImplemented } from "../errors.js";

export const SKILL_NAME = "overnote-axi";

export function buildSkill(_topLevelHelp: string): string {
  throw notImplemented("buildSkill");
}

export type SkillChange = "installed" | "updated" | "unchanged" | "removed" | "absent";

export function installSkill(_home: string, _content: string): { file: string; change: SkillChange } {
  throw notImplemented("installSkill");
}

export function uninstallSkill(_home: string): { file: string; change: SkillChange } {
  throw notImplemented("uninstallSkill");
}
