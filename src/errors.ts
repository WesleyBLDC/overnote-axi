/**
 * Structured errors (AXI principle 6).
 *
 * Every failure a command can report is an AxiError with a stable `code`. The CLI renders it to
 * stdout as TOON with next-step suggestions and maps it to an exit code: 2 for usage errors,
 * 1 for everything else. Raw dependency output (SQLite messages, socket errno, stack traces)
 * never reaches stdout; translate it into one of these codes first.
 */

export type ErrorCode =
  /** Bad flags or arguments. The only code that exits 2. */
  | "VALIDATION_ERROR"
  /** No note matches the reference. */
  | "NOTE_NOT_FOUND"
  /** A short id or title reference matches more than one note. */
  | "AMBIGUOUS_NOTE"
  /** A content write was aimed at a note in Recently Deleted. */
  | "NOTE_TRASHED"
  /** `move` on a note that is not pinned. */
  | "NOT_PINNED"
  /** The note changed since the caller read it (`--expected-updated-at` mismatch). */
  | "STALE_WRITE"
  /** `edit --old` text does not occur in the note. */
  | "TEXT_NOT_FOUND"
  /** `edit --old` text occurs more than once and `--all` was not given. */
  | "AMBIGUOUS_TEXT"
  /** A markdown rewrite (`edit`, `update --replace`) would lose stored content; `--allow-loss` overrides. */
  | "LOSSY_REWRITE"
  /** The write landed, but the open editor saved over it within the verify window. */
  | "OVERWRITTEN_BY_EDITOR"
  /** Writes need the running Overnote helper and its socket is not answering. */
  | "HELPER_NOT_RUNNING"
  /** The helper did not answer in time. */
  | "HELPER_TIMEOUT"
  /** The helper dropped the connection after a write was sent, so it may or may not have landed. */
  | "OUTCOME_UNKNOWN"
  /** The helper answered with an error the CLI does not map more specifically. */
  | "HELPER_ERROR"
  /** No notes database yet (Overnote was never opened, or the support dir is wrong). */
  | "DATABASE_NOT_FOUND"
  /** The database exists but could not be read. */
  | "DATABASE_ERROR"
  /** Filesystem failure outside the notes database (content files, hook config). */
  | "IO_ERROR"
  /** Placeholder for command modules that are not implemented yet. */
  | "NOT_IMPLEMENTED"
  | "UNKNOWN";

/** A scalar detail field. */
export type DetailScalar = string | number | boolean | null;
/**
 * Extra TOON fields of an error: scalars, or uniform rows (for example the candidates of
 * AMBIGUOUS_NOTE), which render as a TOON table.
 */
export type ErrorDetail = DetailScalar | readonly Readonly<Record<string, DetailScalar>>[];
export type ErrorDetails = Readonly<Record<string, ErrorDetail>>;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export class AxiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly suggestions: readonly string[] = [],
    /** Optional extra TOON fields rendered between `code:` and `help:` (for example the stored `updatedAt`). */
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "AxiError";
  }
}

export function exitCodeFor(error: unknown): number {
  return error instanceof AxiError && error.code === "VALIDATION_ERROR" ? EXIT_USAGE : EXIT_ERROR;
}

export function axiError(
  message: string,
  code: ErrorCode,
  suggestions: readonly string[] = [],
  details: ErrorDetails = {},
): AxiError {
  return new AxiError(message, code, suggestions, details);
}

export function validation(message: string, suggestions: readonly string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

/** Fixed next steps for an unexpected failure (AXI principle 6: every error names a fix). */
export function unknownFailureHelp(argv: readonly string[]): string[] {
  const args = argv.join(" ");
  return ["overnote-axi status", `OVERNOTE_AXI_DEBUG=1 overnote-axi${args ? ` ${args}` : ""}`];
}

export function notImplemented(what: string): AxiError {
  return new AxiError(`${what} is not implemented yet`, "NOT_IMPLEMENTED");
}
