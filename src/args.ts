/**
 * Declarative argv parsing against a CommandSpec (AXI principle 6: fail loud on unrecognized
 * input). Everything here runs before a command touches the database or the helper.
 *
 * Grammar:
 * - `--name value` and `--name=value`; a value that starts with `--` must use the `=` form.
 * - Boolean flags take no value; `--flag=x` is rejected rather than ignored.
 * - `--` ends flag parsing, so later tokens are positionals even if they start with dashes.
 * - A lone `-` is a positional (it means stdin where a command accepts content).
 * - Repeating a flag is an error, except that `list` flags merge their comma separated values.
 * - Short flags do not exist; `-h` and friends are unknown flags.
 * - An unknown flag within edit distance 2 of a declared one suggests it (did you mean).
 *
 * Messages start with a word and stay lowercase (a leading `--` would make TOON quote the line),
 * list valid values comma separated, and never embed JSON quoted values.
 */
import type { CommandSpec, FlagSpec, FlagValue, ParsedArgs } from "./command.js";
import { validation } from "./errors.js";
import { NAME } from "./meta.js";

export const HELP_FLAG = "--help";

export function wantsHelp(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes(HELP_FLAG);
}

export function parseArgs(spec: CommandSpec, argv: readonly string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  /** argv index of each positional, so a choice error can rebuild the invocation around it. */
  const positionAt: number[] = [];
  const byName = new Map(spec.flags.map((flag) => [flag.name, flag]));

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      positionAt.push(...argv.slice(i + 1).map((_, offset) => i + 1 + offset));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      positionAt.push(i);
      continue;
    }

    const eq = token.indexOf("=");
    const name = token.startsWith("--") ? token.slice(2, eq === -1 ? undefined : eq) : token.slice(1);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const flag = token.startsWith("--") ? byName.get(name) : undefined;
    if (!flag) {
      throw unknownFlag(spec, token.startsWith("--") ? `--${name}` : token, (close) =>
        correctedInvocation(spec.name, argv, i, 1, [inline === undefined ? close : `${close}=${inline}`]),
      );
    }

    let raw: string | undefined;
    const at = i;
    if (flag.type === "boolean") {
      if (inline !== undefined) {
        throw validation(`flag --${flag.name} takes no value`, [`pass just --${flag.name}`]);
      }
    } else if (inline !== undefined) {
      raw = inline;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw missingValue(flag);
      raw = next;
      i += 1;
    }

    const value = convert(spec, flag, raw, (fixed) =>
      correctedInvocation(spec.name, argv, at, inline === undefined ? 2 : 1, inline === undefined ? [`--${flag.name}`, fixed] : [`--${flag.name}=${fixed}`]),
    );
    if (Object.hasOwn(flags, flag.name)) {
      if (flag.type !== "list") {
        throw validation(`flag --${flag.name} was given more than once`, [`pass --${flag.name} a single time`]);
      }
      flags[flag.name] = [...(flags[flag.name] as readonly string[]), ...(value as readonly string[])];
    } else {
      flags[flag.name] = value;
    }
  }

  checkPositionals(spec, positionals, (index, fixed) => correctedInvocation(spec.name, argv, positionAt[index]!, 1, [fixed]));
  return { positionals, flags };
}

/** Builds the corrected invocation for a did-you-mean hint from the fixed value. */
type Corrector = (fixed: string) => string;

function convert(spec: CommandSpec, flag: FlagSpec, raw: string | undefined, correct: Corrector): FlagValue {
  if (flag.type === "boolean") return true;
  const value = raw ?? "";
  if (value === "" && flag.type !== "string") throw missingValue(flag);
  // Every bad value names the fix and the command's help (AXI principle 6).
  const help = `${NAME} ${spec.name} --help`;

  if (flag.type === "number") {
    const number = Number(value);
    const fix = [numberHint(flag), help];
    if (!Number.isInteger(number)) throw validation(`flag --${flag.name} must be a whole number (got ${value})`, fix);
    if (flag.min !== undefined && number < flag.min) {
      throw validation(`flag --${flag.name} must be at least ${flag.min} (got ${number})`, fix);
    }
    if (flag.max !== undefined && number > flag.max) {
      throw validation(`flag --${flag.name} must be at most ${flag.max} (got ${number})`, fix);
    }
    return number;
  }

  if (flag.type === "list") {
    const parts = value.split(",").map((part) => part.trim());
    if (parts.some((part) => part === "")) {
      throw validation(`flag --${flag.name} has an empty entry (got ${value})`, [
        `use a comma separated list such as --${flag.name} a,b`,
        help,
      ]);
    }
    if (flag.choices) {
      const bad = parts.find((part) => !flag.choices!.includes(part));
      if (bad !== undefined) {
        const close = closest(bad, flag.choices);
        const fixed = close ? parts.map((part) => (part === bad ? close : part)).join(",") : undefined;
        throw badChoice(`flag --${flag.name} does not accept ${bad}`, close, fixed && correct(fixed), [validValues(flag.choices), help]);
      }
    }
    return parts;
  }

  if (flag.choices && !flag.choices.includes(value)) {
    const close = closest(value, flag.choices);
    throw badChoice(`flag --${flag.name} does not accept ${value}`, close, close && correct(close), [validValues(flag.choices), help]);
  }
  return value;
}

/** A value outside a flag's or positional's choices: the corrected invocation leads when one is close. */
function badChoice(message: string, close: string | null, corrected: string | null | undefined, rest: readonly string[]) {
  return validation(`${message}${close ? ` (did you mean ${close}?)` : ""}`, [...(corrected ? [corrected] : []), ...rest]);
}

function validValues(choices: readonly string[]): string {
  return `valid values: ${choices.join(", ")}`;
}

/** The accepted range of a number flag, and its default when it has one. */
function numberHint(flag: FlagSpec): string {
  const range =
    flag.min !== undefined && flag.max !== undefined
      ? ` from ${flag.min} to ${flag.max}`
      : flag.min !== undefined
        ? ` of at least ${flag.min}`
        : flag.max !== undefined
          ? ` of at most ${flag.max}`
          : "";
  const fallback = flag.default === undefined ? "" : ` (default ${flag.default})`;
  return `pass --${flag.name} ${flag.value ?? "<n>"} as a whole number${range}${fallback}`;
}

function checkPositionals(spec: CommandSpec, found: readonly string[], correct: (index: number, fixed: string) => string): void {
  const specs = spec.positionals;
  const required = specs.filter((positional) => positional.required).length;
  const variadic = specs.at(-1)?.variadic === true;
  const usage = `${NAME} ${spec.name} --help`;

  if (found.length < required) {
    const missing = specs[found.length]!;
    throw validation(`${spec.name} requires ${missing.name}`, [usageLine(spec), usage]);
  }
  if (!variadic && found.length > specs.length) {
    const surplus = found[specs.length]!;
    const message =
      specs.length === 0
        ? `${spec.name} takes no arguments (got ${surplus})`
        : `${spec.name} takes at most ${specs.length} argument${specs.length === 1 ? "" : "s"} (got ${surplus})`;
    throw validation(message, [usageLine(spec), usage]);
  }
  found.forEach((value, index) => {
    const positional = specs[Math.min(index, specs.length - 1)];
    if (positional?.choices && !positional.choices.includes(value)) {
      const name = positional.name.replace(/^<(.*)>$/, "$1");
      const close = closest(value, positional.choices);
      throw badChoice(`${name} does not accept ${value}`, close, close && correct(index, close), [
        validValues(positional.choices),
        usageLine(spec),
      ]);
    }
  });
}

function missingValue(flag: FlagSpec) {
  return validation(`flag --${flag.name} requires a value`, [
    `pass it as --${flag.name} ${flag.value ?? "<value>"} or --${flag.name}=${flag.value ?? "<value>"}`,
  ]);
}

function unknownFlag(spec: CommandSpec, token: string, correct: Corrector) {
  const renamed = spec.renamed?.find((entry) => `--${entry.name}` === token);
  if (renamed) return validation(`flag ${token} is no longer supported by ${spec.name}`, [renamed.hint]);
  const names = [...spec.flags.map((flag) => `--${flag.name}`), HELP_FLAG];
  const close = closest(token, names);
  const message = `unknown flag ${token} for ${spec.name}${close ? ` (did you mean ${close}?)` : ""}`;
  return validation(message, [
    ...(close ? [correct(close)] : []),
    `valid flags for ${spec.name}: ${names.join(", ")}`,
    usageLine(spec),
  ]);
}

/** Flags whose value is note content: a hint shows a placeholder, so it cannot repeat a write. */
const CONTENT_PLACEHOLDERS: Readonly<Record<string, string>> = { content: "<markdown>", "content-file": "<file>" };

/**
 * The invocation as typed, with `count` tokens at `start` replaced by `replacement` (DESIGN
 * section 4: a did-you-mean error's first hint). Content values become placeholders.
 */
export function correctedInvocation(
  command: string,
  argv: readonly string[],
  start: number,
  count: number,
  replacement: readonly string[],
): string {
  const tokens = [...argv.slice(0, start), ...replacement, ...argv.slice(start + count)];
  const parts = [NAME, command];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") {
      parts.push("--", ...tokens.slice(i + 1).map(shellQuote));
      break;
    }
    const eq = token.indexOf("=");
    const name = token.startsWith("--") ? token.slice(2, eq === -1 ? undefined : eq) : "";
    const placeholder = Object.hasOwn(CONTENT_PLACEHOLDERS, name) ? CONTENT_PLACEHOLDERS[name] : undefined;
    if (placeholder !== undefined) {
      parts.push(`--${name}`, shellQuote(placeholder));
      if (eq === -1 && tokens[i + 1] !== undefined) i += 1;
      continue;
    }
    parts.push(shellQuote(token));
  }
  return parts.join(" ");
}

/** Levenshtein distance between two strings (insertions, deletions, substitutions). */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Edits a typo may be away from a known name and still be suggested. */
export const MAX_SUGGEST_DISTANCE = 2;

/**
 * The known name closest to `input` within MAX_SUGGEST_DISTANCE (case-insensitive), or null.
 * Ties go to the earlier candidate, so the declared order decides.
 */
export function closest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = MAX_SUGGEST_DISTANCE + 1;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function usageLine(spec: CommandSpec): string {
  const parts = [NAME, spec.name];
  for (const positional of spec.positionals) {
    const name = positional.variadic ? `${positional.name}...` : positional.name;
    parts.push(positional.required ? name : `[${name}]`);
  }
  if (spec.flags.length > 0) parts.push("[flags]");
  return parts.join(" ");
}

/** Concise per-command help (AXI principle 10), rendered from the spec so it cannot drift. */
export function renderCommandHelp(spec: CommandSpec, summary: string): string {
  const lines = [`usage: ${usageLine(spec)}`, summary];

  if (spec.positionals.length > 0) {
    lines.push(`args[${spec.positionals.length}]:`);
    const width = Math.max(...spec.positionals.map((positional) => positional.name.length));
    for (const positional of spec.positionals) {
      const choices = positional.choices ? ` (${positional.choices.join("|")})` : "";
      lines.push(`  ${positional.name.padEnd(width)}  ${positional.description}${choices}`);
    }
  }

  const flagLabels = spec.flags.map((flag) => (flag.value ? `--${flag.name} ${flag.value}` : `--${flag.name}`));
  lines.push(`flags[${spec.flags.length + 1}]:`);
  const width = Math.max(HELP_FLAG.length, ...flagLabels.map((label) => label.length));
  spec.flags.forEach((flag, index) => {
    const extras = [flag.choices ? flag.choices.join("|") : "", flag.default ? `default: ${flag.default}` : ""]
      .filter((part) => part !== "")
      .join("; ");
    lines.push(`  ${flagLabels[index]!.padEnd(width)}  ${flag.description}${extras ? ` (${extras})` : ""}`);
  });
  lines.push(`  ${HELP_FLAG.padEnd(width)}  Show this help`);

  if (spec.notes && spec.notes.length > 0) {
    lines.push("notes:", ...spec.notes.map((note) => `  ${note}`));
  }
  lines.push(`examples[${spec.examples.length}]:`, ...spec.examples.map((example) => `  ${example}`));
  return lines.join("\n");
}

/** Quotes a value for a copy pasteable shell command; bare when it needs no quoting. */
export function shellQuote(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * Rebuilds the current invocation for a next-step hint (AXI principle 9): the same command,
 * positionals, and flags, in spec order, with only the flags in `changes` replaced (`null`
 * removes one). Content flags are never carried forward, so a hint cannot repeat a write.
 */
export function rebuildInvocation(
  spec: CommandSpec,
  args: ParsedArgs,
  changes: Readonly<Record<string, FlagValue | null>> = {},
): string {
  const parts = [NAME, spec.name, ...args.positionals.map(shellQuote)];
  for (const flag of spec.flags) {
    if (flag.name === "content" || flag.name === "content-file") continue;
    const value = Object.hasOwn(changes, flag.name) ? changes[flag.name] : args.flags[flag.name];
    if (value === undefined || value === null || value === false) continue;
    if (value === true) parts.push(`--${flag.name}`);
    else if (Array.isArray(value)) parts.push(`--${flag.name}`, shellQuote(value.join(",")));
    else parts.push(`--${flag.name}`, shellQuote(String(value)));
  }
  return parts.join(" ");
}
