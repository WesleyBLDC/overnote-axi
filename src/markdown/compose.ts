/**
 * Pure no-op rules for content writes (slice: write commands). No I/O and no core import.
 *
 * The document level work (joining blocks, block scoped text replacement, loss checks) lives in
 * src/markdown/convert.ts behind the MarkdownConverter port. This module only decides whether an
 * append or prepend would change anything, so retries are idempotent (docs/DESIGN.md "update").
 */
import { notImplemented } from "../errors.js";

export type ComposeMode = "append" | "prepend";

/**
 * True when the stored markdown already ends (append) or starts (prepend) with the addition,
 * comparing trimmed text. `normalizedAddition` must come from `MarkdownConverter.normalize`, so
 * `* item` is compared as the `- item` core stores.
 */
export function alreadyPresent(_storedMarkdown: string, _normalizedAddition: string, _mode: ComposeMode): boolean {
  throw notImplemented("alreadyPresent");
}
