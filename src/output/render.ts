/**
 * The output boundary. Commands build plain values and hand them to these helpers; nothing else
 * in the CLI formats stdout. See docs/DESIGN.md "Output conventions".
 */
import { encode, type JsonPrimitive } from "./toon.js";

export type Cell = JsonPrimitive;

export interface Column<T> {
  readonly key: string;
  readonly get: (item: T) => Cell;
}

/** Default body truncation for detail views (AXI principle 3 puts it at 500 to 1500 chars). */
export const TRUNCATE_LIMIT = 1200;

export function column<T>(key: string, get: (item: T) => Cell): Column<T> {
  return { key, get };
}

// ---------------------------------------------------------------------------
// Value formatters
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-10-20` in local time. Preferred in list rows: it needs no quoting in TOON. */
export function isoDate(millis: number): string {
  const date = new Date(millis);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2026-10-20 14:03` in local time, for detail views (TOON quotes it because of the colon). */
export function isoMinute(millis: number): string {
  const date = new Date(millis);
  return `${isoDate(millis)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Collapses the home directory to `~` so paths stay short and stable. */
export function collapseHome(file: string, home: string): string {
  if (home !== "" && file === home) return "~";
  if (home !== "" && file.startsWith(`${home}/`)) return `~${file.slice(home.length)}`;
  return file;
}

// ---------------------------------------------------------------------------
// Truncation (AXI principle 3)
// ---------------------------------------------------------------------------

export interface Truncated {
  text: string;
  truncated: boolean;
  /** Length of the full text in Unicode code points (the unit every count in the output uses). */
  total: number;
}

/** Code points, so an emoji counts once, matching Overnote's own character count. */
export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Never drops the field: keeps a preview of at most `limit` code points and states both sizes in
 * the same unit, labeled with what was measured (`markdown chars` for note bodies). The cut
 * lands on the last line break, else the last space, in the final quarter of the window, so a
 * preview never ends mid word; only text without either falls back to a hard cut.
 */
export function truncate(text: string, full = false, limit = TRUNCATE_LIMIT, unit = "markdown chars"): Truncated {
  const points = Array.from(text);
  const total = points.length;
  if (full || total <= limit) return { text, truncated: false, total };
  const window = points.slice(0, limit);
  const floor = Math.floor(limit * 0.75);
  let cut = window.lastIndexOf("\n");
  if (cut < floor) cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  if (cut < floor) cut = limit;
  const head = window.slice(0, cut).join("").replace(/\s+$/, "");
  const shown = codePoints(head);
  return { text: `${head}\n... (truncated, showing ${shown} of ${total} ${unit})`, truncated: true, total };
}

// ---------------------------------------------------------------------------
// Blocks. Each returns a TOON fragment with no trailing newline; joinBlocks() assembles them.
// ---------------------------------------------------------------------------

export function rows<T>(items: readonly T[], columns: readonly Column<T>[]): Record<string, Cell>[] {
  return items.map((item) => {
    const row: Record<string, Cell> = {};
    for (const def of columns) row[def.key] = def.get(item);
    return row;
  });
}

/**
 * `noun` agreeing with `total`: the first `notes` becomes `note` when the total is 1, so
 * `1 of 1 note in Recently Deleted` and `all 1 live note` read correctly.
 */
export function countNoun(total: number, noun: string): string {
  return total === 1 ? noun.replace(/\bnotes\b/, "note") : noun;
}

/** `count: 20 of 143 live notes` (AXI principle 4), with both numbers even when they agree. */
export function countLine(shown: number, total: number, noun: string): string {
  return `${shown} of ${total} ${countNoun(total, noun)}`;
}

/** A uniform list with its aggregate count: `count: ...` then `label[N]{cols}:` rows. */
export function renderList<T>(
  label: string,
  items: readonly T[],
  columns: readonly Column<T>[],
  count: { total: number; noun: string },
): string {
  return encode({ count: countLine(items.length, count.total, count.noun), [label]: rows(items, columns) });
}

/** A uniform list without a count line, for embedded blocks such as the home view. */
export function renderRows<T>(label: string, items: readonly T[], columns: readonly Column<T>[]): string {
  return encode({ [label]: rows(items, columns) });
}

/** Definitive empty state (AXI principle 5): `notes: 0 live notes`. Still exit 0. */
export function renderEmpty(label: string, sentence: string): string {
  return encode({ [label]: sentence });
}

/** A detail view or confirmation: nested fields, undefined entries dropped. */
export function renderDetail(sections: Record<string, unknown>): string {
  return encode(sections);
}

/**
 * A multi-line text block (note markdown) indented under `label`. Bodies bypass encode() on
 * purpose: TOON has no block scalar, and an escaped one-line string is unreadable and costly.
 */
export function renderTextBlock(label: string, text: string): string {
  if (text === "") return `${label}: (empty)`;
  const lines = text.replace(/\n+$/, "").split("\n");
  return [`${label}:`, ...lines.map((line) => (line === "" ? "" : `  ${line}`))].join("\n");
}

/** Next-step hints (AXI principle 9), one complete command per line. */
export function renderHelp(lines: readonly string[]): string {
  const clean = lines.filter((line) => line.trim() !== "");
  if (clean.length === 0) return "";
  return [`help[${clean.length}]:`, ...clean.map((line) => `  ${line}`)].join("\n");
}

/** Structured error on stdout (AXI principle 6). */
export function renderError(
  message: string,
  code: string,
  suggestions: readonly string[] = [],
  details: Record<string, unknown> = {},
): string {
  return joinBlocks([encode({ error: message, code, ...details }), renderHelp(suggestions)]);
}

/** Joins blocks with single newlines, dropping empty ones. */
export function joinBlocks(blocks: readonly string[]): string {
  return blocks
    .map((block) => block.replace(/\n+$/, ""))
    .filter((block) => block !== "")
    .join("\n");
}
