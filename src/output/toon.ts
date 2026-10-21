/**
 * A small TOON encoder (https://toonformat.dev, spec sections 2 and 5 to 12), so the CLI ships with
 * zero runtime dependencies.
 *
 * It covers the whole JSON data model with the comma delimiter and two-space indentation:
 * primitives, nested objects, inline primitive arrays, tabular arrays (including nested field
 * groups), keyed tabular objects, and list form for everything else.
 * Internal code works on plain values; only the output layer calls encode().
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface Line {
  depth: number;
  text: string;
}

interface Field {
  key: string;
  children: Field[] | null;
}

const INDENT = "  ";
const DELIMITER = ",";
const UNQUOTED_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NUMERIC_LIKE = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;

/** Encodes a value as a TOON document (no trailing newline). */
export function encode(value: unknown): string {
  const normalized = normalize(value);
  const lines: Line[] = [];
  if (isObject(normalized)) {
    const keyed = keyedFields(normalized);
    if (keyed) pushKeyedTable(lines, null, normalized, keyed, 0);
    else pushObjectFields(lines, normalized, 0);
  } else if (Array.isArray(normalized)) {
    pushArray(lines, null, normalized, 0);
  } else {
    return encodePrimitive(normalized, true);
  }
  return lines.map((line) => INDENT.repeat(line.depth) + line.text).join("\n");
}

/** Encodes one string or number the way it would appear as a TOON value. */
export function encodePrimitive(value: JsonPrimitive, root = false): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  return needsQuotes(value, root) ? quote(value) : value;
}

export function encodeKey(key: string): string {
  return UNQUOTED_KEY.test(key) ? key : quote(key);
}

// ---------------------------------------------------------------------------
// Normalization (spec section 3): undefined fields dropped, non-finite numbers to null,
// Dates to ISO strings, anything else stringified.
// ---------------------------------------------------------------------------

function normalize(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || typeof entry === "function") continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return String(value);
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: JsonValue): value is JsonPrimitive {
  return value === null || typeof value !== "object";
}

// ---------------------------------------------------------------------------
// Primitives (spec sections 2 and 7)
// ---------------------------------------------------------------------------

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) return "null";
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function needsQuotes(value: string, root: boolean): boolean {
  if (value === "") return true;
  if (value !== value.trim() || /^[ \t]|[ \t]$/.test(value)) return true;
  if (value === "true" || value === "false" || value === "null") return true;
  if (NUMERIC_LIKE.test(value)) return true;
  if (/[:"\\[\]{}]/.test(value)) return true;
  if (CONTROL.test(value)) return true;
  if (value.includes(DELIMITER)) return true;
  if (value.startsWith("-") || value.startsWith("#")) return true;
  if (root && value.startsWith("\ufeff")) return true;
  return false;
}

function quote(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

// ---------------------------------------------------------------------------
// Objects (spec section 8) and keyed tabular objects (section 9.5)
// ---------------------------------------------------------------------------

function pushObjectFields(lines: Line[], object: JsonObject, depth: number): void {
  for (const [key, value] of Object.entries(object)) pushField(lines, key, value, depth);
}

function pushField(lines: Line[], key: string, value: JsonValue, depth: number): void {
  const name = encodeKey(key);
  if (isPrimitive(value)) {
    lines.push({ depth, text: `${name}: ${encodePrimitive(value)}` });
  } else if (Array.isArray(value)) {
    pushArray(lines, name, value, depth);
  } else {
    const keyed = keyedFields(value);
    if (keyed) {
      pushKeyedTable(lines, name, value, keyed, depth);
    } else {
      lines.push({ depth, text: `${name}:` });
      pushObjectFields(lines, value, depth + 1);
    }
  }
}

/** Field structure when an object qualifies for keyed tabular form, else null. */
function keyedFields(object: JsonObject): Field[] | null {
  const values = Object.values(object);
  if (values.length < 2) return null;
  if (!values.every((value) => isObject(value) && Object.keys(value).length > 0)) return null;
  return tabularFields(values as JsonObject[]);
}

function pushKeyedTable(lines: Line[], name: string | null, object: JsonObject, fields: Field[], depth: number): void {
  const entries = Object.entries(object);
  lines.push({ depth, text: `${name ?? ""}[${entries.length}:]{${headerFields(fields)}}:` });
  for (const [key, value] of entries) {
    lines.push({ depth: depth + 1, text: `${encodeKey(key)}: ${rowCells(value as JsonObject, fields)}` });
  }
}

// ---------------------------------------------------------------------------
// Arrays (spec section 9) and objects as list items (section 10)
// ---------------------------------------------------------------------------

function pushArray(lines: Line[], name: string | null, array: JsonValue[], depth: number): void {
  const label = name ?? "";
  if (array.length === 0) {
    lines.push({ depth, text: name === null ? "[]" : `${name}: []` });
    return;
  }
  if (array.every(isPrimitive)) {
    lines.push({ depth, text: `${label}[${array.length}]: ${inlineValues(array)}` });
    return;
  }
  const fields = array.every((item) => isObject(item) && Object.keys(item).length > 0)
    ? tabularFields(array as JsonObject[])
    : null;
  if (fields) {
    lines.push({ depth, text: `${label}[${array.length}]{${headerFields(fields)}}:` });
    for (const item of array) lines.push({ depth: depth + 1, text: rowCells(item as JsonObject, fields) });
    return;
  }
  lines.push({ depth, text: `${label}[${array.length}]:` });
  pushListItems(lines, array, depth + 1);
}

function pushListItems(lines: Line[], items: JsonValue[], depth: number): void {
  for (const item of items) {
    if (isPrimitive(item)) {
      lines.push({ depth, text: `- ${encodePrimitive(item)}` });
    } else if (Array.isArray(item)) {
      if (item.every(isPrimitive)) {
        lines.push({ depth, text: `- [${item.length}]:${item.length > 0 ? ` ${inlineValues(item)}` : ""}` });
      } else {
        lines.push({ depth, text: `- [${item.length}]:` });
        pushListItems(lines, item, depth + 1);
      }
    } else if (Object.keys(item).length === 0) {
      lines.push({ depth, text: "-" });
    } else {
      // Fields of a list-item object sit at depth + 1; the first one moves onto the hyphen line.
      const fieldLines: Line[] = [];
      pushObjectFields(fieldLines, item, depth + 1);
      const [first, ...rest] = fieldLines;
      lines.push({ depth, text: `- ${first!.text}` }, ...rest);
    }
  }
}

function inlineValues(values: JsonPrimitive[]): string {
  return values.map((value) => encodePrimitive(value)).join(DELIMITER);
}

/**
 * Tabular detection (spec section 9.3): same key set everywhere, and every column either all
 * primitives or all non-empty objects that recursively qualify (a nested field group).
 */
function tabularFields(objects: JsonObject[]): Field[] | null {
  const first = objects[0];
  if (!first) return null;
  const keys = Object.keys(first);
  if (keys.length === 0) return null;
  for (const object of objects) {
    const own = Object.keys(object);
    if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(object, key))) return null;
  }
  const fields: Field[] = [];
  for (const key of keys) {
    const column = objects.map((object) => object[key]!);
    if (column.every(isPrimitive)) {
      fields.push({ key, children: null });
    } else if (column.every((value) => isObject(value) && Object.keys(value).length > 0)) {
      const children = tabularFields(column as JsonObject[]);
      if (!children) return null;
      fields.push({ key, children });
    } else {
      return null;
    }
  }
  return fields;
}

function headerFields(fields: Field[]): string {
  return fields
    .map((field) => encodeKey(field.key) + (field.children ? `{${headerFields(field.children)}}` : ""))
    .join(DELIMITER);
}

function rowCells(object: JsonObject, fields: Field[]): string {
  const cells: string[] = [];
  const walk = (value: JsonObject, list: Field[]): void => {
    for (const field of list) {
      const cell = value[field.key]!;
      if (field.children) walk(cell as JsonObject, field.children);
      else cells.push(encodePrimitive(cell as JsonPrimitive));
    }
  };
  walk(object, fields);
  return cells.join(DELIMITER);
}
