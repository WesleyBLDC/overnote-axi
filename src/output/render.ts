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

/** Compact age such as `45s`, `3m`, `2h`, `5d`, `4mo`, `1y`. */
export function relativeTime(millis: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - millis) / 1000));
  const units: readonly [limit: number, per: number, label: string][] = [
    [60, 1, "s"],
    [3600, 60, "m"],
    [86400, 3600, "h"],
    [2592000, 86400, "d"],
    [31536000, 2592000, "mo"],
    [Number.POSITIVE_INFINITY, 31536000, "y"],
  ];
  for (const [limit, per, label] of units) {
    if (seconds < limit) return `${Math.floor(seconds / per)}${label}`;
  }
  return "0s";
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
  /** Length of the full text in UTF-16 code units, as shown to the agent. */
  total: number;
}

/** Never drops the field: keeps a preview and states the full size. */
export function truncate(text: string, full = false, limit = TRUNCATE_LIMIT): Truncated {
  const total = text.length;
  if (full || total <= limit) return { text, truncated: false, total };
  const head = text.slice(0, limit).replace(/\s+$/, "");
  return { text: `${head}\n... (truncated, ${total} chars total)`, truncated: true, total };
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

/** `count: 20 of 143 live notes` (AXI principle 4). */
export function countLine(shown: number, total: number, noun: string): string {
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
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
