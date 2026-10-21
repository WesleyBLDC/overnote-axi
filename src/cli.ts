/**
 * Dispatcher: argv to one command, output to stdout, an exit code back to bin/overnote-axi.ts.
 *
 * - No arguments runs `home` (AXI principle 8: content first).
 * - `--help` or `help` alone prints the top-level help; `<command> ... --help`, `help <command>`,
 *   and `<command> help` (for a command whose first argument cannot be `help`) print that
 *   command's help.
 * - An unknown command within edit distance 2 of a real one suggests it (did you mean).
 * - Flags must follow the command; a leading flag is a usage error with a corrected example.
 * - Every error is rendered to stdout as TOON (principle 6) and nothing leaks to stderr.
 */
import { closest, correctedInvocation, parseArgs, renderCommandHelp, wantsHelp } from "./args.js";
import type { CommandSpec } from "./command.js";
import type { Context, Output } from "./context.js";
import { AxiError, axiError, EXIT_OK, exitCodeFor, unknownFailureHelp, validation } from "./errors.js";
import { NOTE_REF_HELP } from "./guidance.js";
import { DESCRIPTION, NAME } from "./meta.js";
import { renderError } from "./output/render.js";
import { COMMANDS, findCommand } from "./registry.js";

export interface MainOptions {
  argv?: readonly string[];
  stdout?: Output;
  /** Injected by tests; production builds the runtime context lazily. */
  context?: Context;
}

export function topLevelHelp(): string {
  const width = Math.max(...COMMANDS.map((entry) => entry.name.length));
  return [
    `usage: ${NAME} [command] [args] [flags]`,
    `description: ${DESCRIPTION}`,
    `commands[${COMMANDS.length}]:`,
    ...COMMANDS.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}`),
    "notes:",
    `  ${NOTE_REF_HELP}`,
    "  Reads work while Overnote is closed; writes go through the running Overnote app",
    "  Flags go after the command, and every command takes --help",
    "  Exit codes: 0 success (including no-ops), 1 error, 2 usage error",
    "examples[4]:",
    `  ${NAME} read current`,
    `  ${NAME} search "standup"`,
    `  ${NAME} update <id> --content "- [ ] follow up"`,
    `  ${NAME}`,
  ].join("\n");
}

/**
 * The corrected invocation for argv that starts with a flag: `--help <command>` becomes
 * `<command> --help`, a leading `--` is dropped, and any other flag is moved behind `home`.
 */
export function leadingFlagFix(argv: readonly string[]): string {
  const [first, ...rest] = argv;
  if (first === "--help" && rest[0] !== undefined && findCommand(rest[0])) {
    return [NAME, rest[0], "--help"].join(" ");
  }
  if (first === "--") return [NAME, ...rest].join(" ");
  return [NAME, "home", ...argv].join(" ");
}

/** The word `help` stands for `--help`: alone, before a command, or as a command's only argument. */
const HELP_WORD = "help";

/**
 * True when `<command> help` means help rather than an argument: the command takes no argument,
 * or its first argument is a fixed choice that `help` is not (a note ref or a query could be `help`).
 */
function helpWordIsHelp(spec: CommandSpec, rest: readonly string[]): boolean {
  if (rest.length !== 1 || rest[0] !== HELP_WORD) return false;
  const first = spec.positionals[0];
  return first === undefined || (first.choices !== undefined && !first.choices.includes(HELP_WORD));
}

/** The unknown command error, with the closest command (when one is near) as the first fix. */
function unknownCommand(name: string, rest: readonly string[]) {
  const close = closest(name, COMMANDS.map((command) => command.name));
  return validation(`unknown command ${name}${close ? ` (did you mean ${close}?)` : ""}`, [
    ...(close ? [correctedInvocation(close, rest, 0, 0, [])] : []),
    `valid commands: ${COMMANDS.map((command) => command.name).join(", ")}`,
    `${NAME} --help`,
  ]);
}

export interface ErrorSource {
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Agents often pipe output into `head`. When the reader goes away, stdout emits EPIPE; that is
 * a normal end of output, so the process exits 0 instead of printing a stack (AXI principle 6).
 * Anything else is rethrown. Called once by bin/overnote-axi.ts on the real stdout.
 */
export function guardStdout(stream: ErrorSource, setExitCode: (code: number) => void, exit: () => void): void {
  stream.once("error", (error) => {
    if (error.code !== "EPIPE") throw error;
    setExitCode(EXIT_OK);
    exit();
  });
}

export async function main(options: MainOptions = {}): Promise<number> {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const stdout = options.stdout ?? process.stdout;
  let context = options.context;

  const write = (text: string) => {
    stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === HELP_WORD)) {
      write(topLevelHelp());
      return EXIT_OK;
    }
    if (argv.length === 2 && argv[0] === HELP_WORD) {
      // `help read` is `read --help`; `help bogus` fails like `bogus` would.
      argv.splice(0, 2, argv[1]!, "--help");
    }

    const first = argv[0];
    if (first !== undefined && first.startsWith("-")) {
      throw validation(`flags go after the command (got ${first} first)`, [leadingFlagFix(argv), `${NAME} --help`]);
    }

    const name = first ?? "home";
    const entry = findCommand(name);
    const rest = argv.slice(1);
    if (!entry) throw unknownCommand(name, rest);

    const { command } = await entry.load();
    if (wantsHelp(rest) || helpWordIsHelp(command, rest)) {
      write(renderCommandHelp(command, entry.summary));
      return EXIT_OK;
    }

    const args = parseArgs(command, rest);
    if (!context) {
      const { createRuntimeContext } = await import("./runtime.js");
      context = createRuntimeContext();
    }
    const result = await command.run(args, context);
    write(result.output);
    return result.exitCode ?? EXIT_OK;
  } catch (error) {
    const failure =
      error instanceof AxiError ? error : axiError("unexpected failure", "UNKNOWN", unknownFailureHelp(argv));
    write(renderError(failure.message, failure.code, failure.suggestions, failure.details));
    if (!(error instanceof AxiError) && process.env.OVERNOTE_AXI_DEBUG) {
      // Diagnostics only on request, and on stderr where agents do not read.
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    return exitCodeFor(failure);
  } finally {
    context?.close();
  }
}
