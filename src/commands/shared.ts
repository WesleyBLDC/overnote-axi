/**
 * Flag and argument specs shared by several commands, so the same flag reads the same everywhere.
 * Data only: behavior lives in each command module.
 */
import type { FlagSpec, PositionalSpec } from "../command.js";

export const NOTE_ARG: PositionalSpec = {
  name: "<note>",
  description: "Full id, unique id prefix or suffix (6+ chars), current, or title:<exact title>",
  required: true,
};

export const CONTENT_FLAGS: readonly FlagSpec[] = [
  {
    name: "content",
    type: "string",
    value: "<markdown>",
    description: "Markdown to write; pass - to read it from stdin",
  },
  {
    name: "content-file",
    type: "string",
    value: "<path>",
    description: "Read the markdown from a UTF-8 file",
  },
];

export const EXPECTED_UPDATED_AT_FLAG: FlagSpec = {
  name: "expected-updated-at",
  type: "number",
  value: "<ms>",
  min: 0,
  description: "Refuse the write unless the note's updatedAt still equals this value (from read)",
};

export const ALLOW_LOSS_FLAG: FlagSpec = {
  name: "allow-loss",
  type: "boolean",
  description: "Write even though the markdown rewrite drops content LOSSY_REWRITE named",
};

export function limitFlag(defaultValue: number, max = 500): FlagSpec {
  return {
    name: "limit",
    type: "number",
    value: "<n>",
    min: 1,
    max,
    default: String(defaultValue),
    description: "Maximum rows to show",
  };
}

export const OFFSET_FLAG: FlagSpec = {
  name: "offset",
  type: "number",
  value: "<n>",
  min: 0,
  default: "0",
  description: "Skip this many rows first (for paging)",
};

/** Columns `list` and `trash` can show. Default: id,title,updated. */
export const LIST_FIELDS = ["id", "title", "updated", "created", "accessed", "deleted", "chars", "pinned", "preview"] as const;
export const DEFAULT_LIST_FIELDS = ["id", "title", "updated"] as const;

/** Columns `search` can show. Default: id,title,match. */
export const SEARCH_FIELDS = ["id", "title", "match", "updated", "chars", "pinned"] as const;
export const DEFAULT_SEARCH_FIELDS = ["id", "title", "match"] as const;

export function fieldsFlag(choices: readonly string[], defaults: readonly string[]): FlagSpec {
  return {
    name: "fields",
    type: "list",
    value: "<a,b,c>",
    choices,
    default: defaults.join(","),
    description: "Columns to show, in order",
  };
}
