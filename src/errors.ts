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
  /** Writes need the running Overnote helper and its socket is not answering. */
  | "HELPER_NOT_RUNNING"
  /** The helper did not answer in time. */
  | "HELPER_TIMEOUT"
  /** The helper answered with an error the CLI does not map more specifically. */
  | "HELPER_ERROR"
  /** No notes database yet (Overnote was never opened, or the support dir is wrong). */
  | "DATABASE_NOT_FOUND"
  /** The database exists but could not be read. */
  | "DATABASE_ERROR"
  /** Filesystem failure outside the notes database (content files, hook config). */
  | "IO_ERROR"
  /** Scaffold placeholder; must not survive the build phase. */
  | "NOT_IMPLEMENTED"
  | "UNKNOWN";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export class AxiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly suggestions: readonly string[] = [],
    /** Optional extra TOON fields rendered between `code:` and `help:` (for example the stored `updatedAt`). */
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
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
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): AxiError {
  return new AxiError(message, code, suggestions, details);
}

export function validation(message: string, suggestions: readonly string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function notImplemented(what: string): AxiError {
  return new AxiError(`${what} is not implemented yet`, "NOT_IMPLEMENTED");
}
