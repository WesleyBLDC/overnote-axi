/**
 * Pure no-op rules for content writes. No I/O and no core import.
 *
 * The document level work (joining blocks, block scoped text replacement, loss checks) lives in
 * src/markdown/convert.ts behind the MarkdownConverter port. This module only decides whether a
 * write would change anything, so retries are idempotent (docs/DESIGN.md "update" and "edit").
 */

/**
 * True when the stored markdown already ends (append) or starts (prepend, top) with the
 * addition, comparing trimmed text. `normalizedAddition` must come from
 * `MarkdownConverter.normalize`, so `* item` is compared as the `- item` core stores. For a
 * prepend below the title line, pass `MarkdownConverter.belowTitle` as the stored markdown.
 *
 * The match must sit on a line boundary: a note ending in `- call Sam` already holds the
 * addition `- call Sam`, but not the addition `Sam`, which would be a new paragraph. An empty
 * addition is never present, so callers reject empty content before asking.
 */
export function alreadyPresent(storedMarkdown: string, normalizedAddition: string, mode: "append" | "prepend" | "top"): boolean {
  const stored = storedMarkdown.trim();
  const addition = normalizedAddition.trim();
  if (addition === "") return false;
  if (stored === addition) return true;
  return mode === "append" ? stored.endsWith(`\n${addition}`) : stored.startsWith(`${addition}\n`);
}

/** Non overlapping occurrences of `needle` in `haystack` (0 for an empty needle). */
export function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/**
 * True when an `edit` that found no `--old` text is a retry of a whole line edit that already
 * landed, so the result is a no-op instead of `TEXT_NOT_FOUND` (docs/DESIGN.md "edit").
 * Every condition must hold:
 *
 * 1. `--all` is not set (a replace all retry cannot tell which lines it changed);
 * 2. `--new`, normalized (`normalizedNew`, from `MarkdownConverter.normalize`) and trimmed, is not blank;
 * 3. `--old` occurs 0 times in the stored markdown;
 * 4. the lines of the normalized `--new` equal a contiguous run of whole lines of the stored
 *    markdown exactly once, ignoring trailing whitespace on each line;
 * 5. the raw `--new` occurs exactly once as a substring of the stored markdown.
 *
 * So `--new Sam` inside `- [ ] call Sam`, or `--new x` inside `[x]`, is never taken as applied.
 */
export function alreadyEdited(
  storedMarkdown: string,
  newText: string,
  options: { oldText: string; all: boolean; normalizedNew?: string },
): boolean {
  if (options.all) return false;
  const normalized = (options.normalizedNew ?? newText).trim();
  if (normalized === "") return false;
  if (occurrences(storedMarkdown, options.oldText) !== 0) return false;
  if (wholeLineRuns(storedMarkdown, normalized) !== 1) return false;
  return occurrences(storedMarkdown, newText) === 1;
}

/** How many times the lines of `needle` appear as a contiguous run of whole lines of `haystack`. */
function wholeLineRuns(haystack: string, needle: string): number {
  const stored = haystack.split("\n").map((line) => line.trimEnd());
  const wanted = needle.split("\n").map((line) => line.trimEnd());
  let count = 0;
  for (let start = 0; start + wanted.length <= stored.length; start++) {
    if (wanted.every((line, offset) => stored[start + offset] === line)) count++;
  }
  return count;
}
