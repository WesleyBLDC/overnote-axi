/**
 * Dispatcher: argv to one command, output to stdout, an exit code back to bin/overnote-axi.ts.
 *
 * - No arguments runs `home` (AXI principle 8: content first).
 * - `--help` alone prints the top-level help; `<command> ... --help` prints that command's help.
 * - Flags must follow the command; a leading flag is a usage error with a corrected example.
 * - Every error is rendered to stdout as TOON (principle 6) and nothing leaks to stderr.
 */
import { parseArgs, renderCommandHelp, wantsHelp } from "./args.js";
import type { Context, Output } from "./context.js";
import { AxiError, axiError, EXIT_OK, exitCodeFor, unknownFailureHelp, validation } from "./errors.js";
import { DESCRIPTION, NAME } from "./meta.js";
import { renderError } from "./output/render.js";
import { COMMANDS, findCommand } from "./registry.js";

export interface MainOptions {
  argv?: readonly string[];
  stdout?: Output;
  /** Injected by tests; production builds the runtime context lazily. */
  context?: Context;
}

export const NOTE_REF_HELP =
  "<note> is a full id, a unique id prefix or suffix (6+ chars), current, or title:<exact title>";

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
    `  ${NAME}`,
    `  ${NAME} search "standup"`,
    `  ${NAME} read current`,
    `  ${NAME} update current --content "- [ ] follow up"`,
  ].join("\n");
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
    if (argv.length === 1 && argv[0] === "--help") {
      write(topLevelHelp());
      return EXIT_OK;
    }

    const first = argv[0];
    if (first !== undefined && first.startsWith("-")) {
      throw validation(`flags go after the command (got ${first} first)`, [
        `${NAME} home ${argv.join(" ")}`,
        `${NAME} --help`,
      ]);
    }

    const name = first ?? "home";
    const entry = findCommand(name);
    if (!entry) {
      throw validation(`unknown command ${name}`, [
        `Valid commands: ${COMMANDS.map((command) => command.name).join(" ")}`,
        `${NAME} --help`,
      ]);
    }

    const rest = argv.slice(1);
    const { command } = await entry.load();
    if (wantsHelp(rest)) {
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
      error instanceof AxiError ? error : axiError("Unexpected failure", "UNKNOWN", unknownFailureHelp(argv));
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
