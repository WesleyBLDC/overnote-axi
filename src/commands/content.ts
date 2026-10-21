/**
 * Reads the markdown a write command was given: exactly one of
 * `--content <md>`, `--content -` (stdin), or `--content-file <path>`. Giving two is a usage
 * error; a missing or unreadable file is IO_ERROR. Content is used verbatim (no trimming beyond
 * a single trailing newline).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { flagString, type ParsedArgs } from "../command.js";
import type { Context } from "../context.js";
import { axiError, validation } from "../errors.js";

/** Drops one trailing newline (`\n` or `\r\n`), the one a file or `echo` adds. */
function withoutTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** The content, or null when no content flag was given (callers decide whether that is an error). */
export async function readContent(args: ParsedArgs, context: Context): Promise<string | null> {
  const inline = flagString(args, "content");
  const file = flagString(args, "content-file");

  if (inline !== undefined && file !== undefined) {
    throw validation("give either --content or --content-file, not both", [
      'Pass the markdown inline with --content "<markdown>"',
      "Or read it from a file with --content-file <path>",
    ]);
  }

  if (inline === "-") {
    const stdin = await context.readStdin();
    if (stdin === null) {
      throw validation("content from stdin (--content -) needs a pipe, but stdin is a terminal", [
        'Pipe the markdown in: printf "<markdown>" | overnote-axi <command> ... --content -',
        "Or pass --content-file <path>",
      ]);
    }
    return withoutTrailingNewline(stdin);
  }
  if (inline !== undefined) return inline;

  if (file !== undefined) {
    if (file.trim() === "") throw validation("the --content-file flag needs a path", ["Pass --content-file <path>"]);
    const resolved = path.resolve(context.cwd, file);
    try {
      return withoutTrailingNewline(await readFile(resolved, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason =
        code === "ENOENT" ? "does not exist" : code === "EISDIR" ? "is a directory" : code === "EACCES" ? "is not readable" : "could not be read";
      throw axiError(`the content file ${file} ${reason}`, "IO_ERROR", [
        "Check the path, or pass the markdown with --content",
      ], { file: resolved });
    }
  }
  return null;
}

/** Like readContent, but the content is required and must not be blank. */
export async function requireContent(args: ParsedArgs, context: Context, command: string): Promise<string> {
  const content = await readContent(args, context);
  if (content === null) {
    throw validation(`${command} needs content`, [
      `overnote-axi ${command} <note> --content "<markdown>"`,
      `overnote-axi ${command} <note> --content-file <path>`,
    ]);
  }
  if (content.trim() === "") {
    throw validation("the content is empty", [`Pass the markdown to write with --content "<markdown>"`]);
  }
  return content;
}
