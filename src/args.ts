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
  const byName = new Map(spec.flags.map((flag) => [flag.name, flag]));

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = token.startsWith("--") ? token.slice(2, eq === -1 ? undefined : eq) : token.slice(1);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const flag = token.startsWith("--") ? byName.get(name) : undefined;
    if (!flag) throw unknownFlag(spec, token.startsWith("--") ? `--${name}` : token);

    let raw: string | undefined;
    if (flag.type === "boolean") {
      if (inline !== undefined) {
        throw validation(`--${flag.name} is a boolean flag and takes no value`, [`Pass just --${flag.name}`]);
      }
    } else if (inline !== undefined) {
      raw = inline;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw missingValue(flag);
      raw = next;
      i += 1;
    }

    const value = convert(flag, raw);
    if (Object.hasOwn(flags, flag.name)) {
      if (flag.type !== "list") {
        throw validation(`--${flag.name} was given more than once`, [`Pass --${flag.name} a single time`]);
      }
      flags[flag.name] = [...(flags[flag.name] as readonly string[]), ...(value as readonly string[])];
    } else {
      flags[flag.name] = value;
    }
  }

  checkPositionals(spec, positionals);
  return { positionals, flags };
}

function convert(flag: FlagSpec, raw: string | undefined): FlagValue {
  if (flag.type === "boolean") return true;
  const value = raw ?? "";
  if (value === "" && flag.type !== "string") throw missingValue(flag);

  if (flag.type === "number") {
    const number = Number(value);
    if (!Number.isInteger(number)) throw validation(`--${flag.name} must be a whole number (got ${value})`);
    if (flag.min !== undefined && number < flag.min) {
      throw validation(`--${flag.name} must be at least ${flag.min} (got ${number})`);
    }
    if (flag.max !== undefined && number > flag.max) {
      throw validation(`--${flag.name} must be at most ${flag.max} (got ${number})`);
    }
    return number;
  }

  if (flag.type === "list") {
    const parts = value.split(",").map((part) => part.trim());
    if (parts.some((part) => part === "")) {
      throw validation(`--${flag.name} has an empty entry in ${JSON.stringify(value)}`, [
        `Use a comma separated list such as --${flag.name} a,b`,
      ]);
    }
    if (flag.choices) {
      const bad = parts.find((part) => !flag.choices!.includes(part));
      if (bad !== undefined) {
        throw validation(`--${flag.name} does not accept ${bad}`, [`Valid values: ${flag.choices.join(" ")}`]);
      }
    }
    return parts;
  }

  if (flag.choices && !flag.choices.includes(value)) {
    throw validation(`--${flag.name} does not accept ${JSON.stringify(value)}`, [
      `Valid values: ${flag.choices.join(" ")}`,
    ]);
  }
  return value;
}

function checkPositionals(spec: CommandSpec, found: readonly string[]): void {
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
        ? `${spec.name} takes no arguments (got ${JSON.stringify(surplus)})`
        : `${spec.name} takes at most ${specs.length} argument${specs.length === 1 ? "" : "s"} (got ${JSON.stringify(surplus)})`;
    throw validation(message, [usageLine(spec), usage]);
  }
  found.forEach((value, index) => {
    const positional = specs[Math.min(index, specs.length - 1)];
    if (positional?.choices && !positional.choices.includes(value)) {
      throw validation(`${positional.name} must be one of ${positional.choices.join(" ")} (got ${JSON.stringify(value)})`, [
        usageLine(spec),
      ]);
    }
  });
}

function missingValue(flag: FlagSpec) {
  return validation(`--${flag.name} requires a value`, [
    `Pass it as --${flag.name} ${flag.value ?? "<value>"} or --${flag.name}=${flag.value ?? "<value>"}`,
  ]);
}

function unknownFlag(spec: CommandSpec, token: string) {
  const renamed = spec.renamed?.find((entry) => `--${entry.name}` === token);
  if (renamed) return validation(`${token} is no longer supported by ${spec.name}`, [renamed.hint]);
  const valid = [...spec.flags.map((flag) => `--${flag.name}`), HELP_FLAG].join(" ");
  return validation(`unknown flag ${token} for ${spec.name}`, [`Valid flags for ${spec.name}: ${valid}`, usageLine(spec)]);
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
