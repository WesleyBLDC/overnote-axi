/**
 * The contract every command module implements. A module under src/commands/ exports one
 * `command: CommandSpec`; src/registry.ts lists them and loads each lazily.
 *
 * Flags and positionals are declared, not parsed by hand: src/args.ts validates argv against the
 * spec before `run` is called, rejects unknown flags (exit 2) and renders `--help` from it.
 */
import type { Context } from "./context.js";

export type FlagType = "boolean" | "string" | "number" | "list";

export interface FlagSpec {
  /** Long name without dashes, for example `limit`. */
  readonly name: string;
  readonly type: FlagType;
  /** Placeholder shown in help, for example `<n>`. Omitted for booleans. */
  readonly value?: string;
  readonly description: string;
  /** Shown in help as `(default: ...)`; the parser does not apply it. */
  readonly default?: string;
  /** Allowed values for a string flag; anything else is a usage error. */
  readonly choices?: readonly string[];
  /** Integer bounds for a number flag. */
  readonly min?: number;
  readonly max?: number;
}

export interface PositionalSpec {
  /** Placeholder shown in usage, for example `<note>`. */
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /** Accepts one or more values (only valid on the last positional). */
  readonly variadic?: boolean;
  /** Allowed values, for example `up` and `down`. */
  readonly choices?: readonly string[];
}

/** Flags removed with a pointer to their replacement, so agents self correct in one step. */
export interface RenamedFlag {
  readonly name: string;
  readonly hint: string;
}

export interface CommandSpec {
  /** Must equal the registry entry's name; the one-line summary lives in src/registry.ts. */
  readonly name: string;
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  readonly renamed?: readonly RenamedFlag[];
  /** Extra help lines (behavior notes), each one sentence. */
  readonly notes?: readonly string[];
  /** Two or three complete invocations. */
  readonly examples: readonly string[];
  readonly run: (args: ParsedArgs, context: Context) => Promise<CommandOutput>;
}

export type FlagValue = boolean | string | number | readonly string[];

export interface ParsedArgs {
  readonly positionals: readonly string[];
  /** Only flags that were present on the command line. */
  readonly flags: Readonly<Record<string, FlagValue>>;
}

/** What a command returns: TOON text for stdout, and exit 0 unless stated. */
export interface CommandOutput {
  readonly output: string;
  readonly exitCode?: number;
}

export function ok(output: string): CommandOutput {
  return { output };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags[name];
  return typeof value === "number" ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagList(args: ParsedArgs, name: string): readonly string[] | undefined {
  const value = args.flags[name];
  return Array.isArray(value) ? (value as readonly string[]) : undefined;
}
