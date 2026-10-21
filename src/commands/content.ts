/**
 * Reads the markdown a write command was given (slice: write commands): exactly one of
 * `--content <md>`, `--content -` (stdin), or `--content-file <path>`. Giving two is a usage
 * error; a missing or unreadable file is IO_ERROR. Content is used verbatim (no trimming beyond
 * a single trailing newline).
 */
import type { ParsedArgs } from "../command.js";
import type { Context } from "../context.js";
import { notImplemented } from "../errors.js";

/** The content, or null when no content flag was given (callers decide whether that is an error). */
export async function readContent(_args: ParsedArgs, _context: Context): Promise<string | null> {
  throw notImplemented("readContent");
}
