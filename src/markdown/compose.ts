/**
 * Pure markdown composition for content writes (slice: write commands). No I/O.
 * See docs/DESIGN.md "update" and "edit" for the exact rules.
 */
import { notImplemented } from "../errors.js";

export type WriteMode = "append" | "prepend" | "replace";

export interface Composed {
  markdown: string;
  /** True when the result equals the existing markdown (an idempotent no-op, exit 0). */
  unchanged: boolean;
}

/**
 * Joins `addition` to `existing` with one blank line between blocks. Append is a no-op when the
 * trimmed note already ends with the trimmed addition; prepend when it already starts with it.
 */
export function compose(_existing: string, _addition: string, _mode: WriteMode): Composed {
  throw notImplemented("compose");
}

export interface EditResult extends Composed {
  /** How many occurrences were replaced. */
  replaced: number;
}

/**
 * Exact substring replacement on markdown. Zero matches is TEXT_NOT_FOUND; more than one without
 * `all` is AMBIGUOUS_TEXT (with the match count in details).
 */
export function replaceText(_existing: string, _oldText: string, _newText: string, _all: boolean): EditResult {
  throw notImplemented("replaceText");
}
