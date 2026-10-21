/**
 * Turns on Codex hooks in `config.toml`: `hooks = true` under `[features]`.
 *
 * The file is edited line by line, with no TOML parser, so nothing the user wrote is reformatted:
 * - an existing `[features]` table gets `hooks = true` right after its header;
 * - an existing `hooks = <value>` key in that table is set to `true` on its own line only;
 * - a key or table name may be bare, double quoted or single quoted (`"hooks" = false`);
 * - no `[features]` table appends one at the end;
 * - `features.hooks = ...` at the top level already decides the flag, and is set the same way;
 * - an inline `features = { ... }` table cannot be edited safely, so it is refused.
 * The original line endings are kept.
 */
import { axiError } from "../errors.js";

export interface TomlEdit {
  text: string;
  changed: boolean;
}

/** A key in any of its TOML spellings: bare, `"double quoted"` or `'single quoted'`. */
function key(name: string): string {
  return `(?:${name}|"${name}"|'${name}')`;
}

const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;
const FEATURES_TABLE = new RegExp(`^${key("features")}$`);
const HOOKS_KEY = new RegExp(`^(\\s*${key("hooks")}\\s*=\\s*)([^#]*?)(\\s*(?:#.*)?)$`);
const DOTTED_HOOKS_KEY = new RegExp(`^(\\s*${key("features")}\\s*\\.\\s*${key("hooks")}\\s*=\\s*)([^#]*?)(\\s*(?:#.*)?)$`);
const INLINE_FEATURES = new RegExp(`^\\s*${key("features")}\\s*=`);

function setTrue(line: string, pattern: RegExp): { line: string; changed: boolean } {
  const match = pattern.exec(line)!;
  if (match[2]!.trim() === "true") return { line, changed: false };
  return { line: `${match[1]}true${match[3]}`, changed: true };
}

export function enableCodexHooks(current: string | null): TomlEdit {
  const source = current ?? "";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source === "" ? [] : source.split(/\r?\n/);
  // A trailing newline leaves one empty last element; it is restored on join.
  const trailing = lines.length > 0 && lines.at(-1) === "";
  if (trailing) lines.pop();

  let table: string | null = null;
  let featuresHeader = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = HEADER.exec(line);
    if (header) {
      table = FEATURES_TABLE.test(header[1]!) ? "features" : header[1]!;
      if (table === "features" && !line.trim().startsWith("[[")) featuresHeader = index;
      continue;
    }
    const inFeatures = table === "features";
    const atRoot = table === null;
    if ((inFeatures && HOOKS_KEY.test(line)) || (atRoot && DOTTED_HOOKS_KEY.test(line))) {
      const edit = setTrue(line, inFeatures ? HOOKS_KEY : DOTTED_HOOKS_KEY);
      lines[index] = edit.line;
      return { text: join(lines, newline, trailing), changed: edit.changed };
    }
    if (atRoot && INLINE_FEATURES.test(line)) {
      throw axiError("config.toml sets features as an inline table, which setup cannot edit safely", "IO_ERROR", [
        "Add hooks = true to the features table in config.toml by hand, then run setup again",
      ]);
    }
  }

  if (featuresHeader !== -1) {
    lines.splice(featuresHeader + 1, 0, "hooks = true");
    return { text: join(lines, newline, trailing), changed: true };
  }
  const separator = lines.length > 0 && lines.at(-1)!.trim() !== "" ? [""] : [];
  lines.push(...separator, "[features]", "hooks = true");
  return { text: join(lines, newline, true), changed: true };
}

function join(lines: readonly string[], newline: string, trailing: boolean): string {
  return lines.join(newline) + (trailing ? newline : "");
}
