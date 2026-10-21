/** `search <query>`. The app's folded substring match; title hits first. */
import { rebuildInvocation } from "../args.js";
import { flagBoolean, flagList, flagNumber, ok, type CommandSpec } from "../command.js";
import type { SearchHit } from "../domain/types.js";
import { validation } from "../errors.js";
import { column, isoDate, joinBlocks, renderEmpty, renderHelp, renderList, type Column } from "../output/render.js";
import { needsPinPositions, oneLine, pinPositions, summaryTitle, type PinPositions, type SearchField } from "./note-columns.js";
import { DEFAULT_SEARCH_FIELDS, fieldsFlag, limitFlag, SEARCH_FIELDS } from "./shared.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 200;
const ELLIPSIS = "...";

/**
 * `title` for a title hit, else the snippet around the first match on one line, with `...` on
 * each side where the note's text goes on.
 */
export function matchCell(hit: SearchHit): string {
  if (hit.titleMatch) return "title";
  const snippet = hit.snippet;
  if (snippet === "") return "";
  const text = oneLine(hit.note.preview);
  const head = text.startsWith(snippet) ? "" : ELLIPSIS;
  // The preview holds only the first 200 characters, so the end is known only for short notes.
  const whole = hit.note.charCount <= Array.from(hit.note.preview).length;
  const tail = whole && text.endsWith(snippet) ? "" : ELLIPSIS;
  return `${head}${snippet}${tail}`;
}

function searchColumn(field: SearchField, positions: PinPositions): Column<SearchHit> {
  switch (field) {
    case "id":
      return column(field, (hit) => hit.note.id);
    case "title":
      return column(field, (hit) => summaryTitle(hit.note));
    case "match":
      return column(field, matchCell);
    case "updated":
      return column(field, (hit) => isoDate(hit.note.updatedAt));
    case "chars":
      return column(field, (hit) => hit.note.charCount);
    case "pinned":
      return column(field, (hit) => (hit.note.pinned === null ? "" : (positions.get(hit.note.id) ?? "")));
  }
}

export const command: CommandSpec = {
  name: "search",
  positionals: [{ name: "<query>", description: "Text to find in titles and note text", required: true }],
  flags: [
    limitFlag(DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
    { name: "trash", type: "boolean", description: "Search Recently Deleted instead of live notes" },
    fieldsFlag(SEARCH_FIELDS, DEFAULT_SEARCH_FIELDS),
  ],
  notes: ["Matching ignores case and accents, like the Overnote search bar"],
  examples: ['overnote-axi search "standup"', "overnote-axi search invoice --trash"],
  run: async (args, context) => {
    const query = args.positionals[0] ?? "";
    if (query.trim() === "") {
      throw validation("search needs a query that is not blank", ['overnote-axi search "<text>"', "overnote-axi list"]);
    }
    const limit = flagNumber(args, "limit") ?? DEFAULT_SEARCH_LIMIT;
    const trashed = flagBoolean(args, "trash");
    const fields = [...new Set((flagList(args, "fields") ?? DEFAULT_SEARCH_FIELDS) as readonly SearchField[])];
    // Single quotes: double quotes inside a TOON value force escaped quoting of the whole line,
    // so they are used only for a query with an apostrophe, which single quotes would garble.
    const trimmed = query.trim();
    const quoted = trimmed.includes("'") ? `"${trimmed}"` : `'${trimmed}'`;

    const { page, positions } = context.reader().snapshot((reader) => ({
      page: reader.search(query, { limit, trashed }),
      positions: needsPinPositions(fields) && !trashed ? pinPositions(reader) : new Map(),
    }));

    if (page.total === 0) {
      const where = trashed ? "notes in Recently Deleted match" : "notes match";
      const other = rebuildInvocation(command, args, { trash: trashed ? null : true });
      return ok(
        joinBlocks([
          renderEmpty("hits", `0 ${where} ${quoted}`),
          renderHelp([other, 'overnote-axi create --content "<markdown>"']),
        ]),
      );
    }

    const noun = trashed ? `notes in Recently Deleted matching ${quoted}` : `notes matching ${quoted}`;
    const more = page.items.length < page.total && limit < MAX_SEARCH_LIMIT;
    const hints = [
      ...(more ? [rebuildInvocation(command, args, { limit: Math.min(page.total, MAX_SEARCH_LIMIT) })] : []),
      "overnote-axi read <id>",
      ...(trashed ? ["overnote-axi recover <id>"] : []),
    ];
    return ok(
      joinBlocks([
        renderList(
          "hits",
          page.items,
          fields.map((field) => searchColumn(field, positions)),
          { total: page.total, noun },
        ),
        renderHelp(hints),
      ]),
    );
  },
};
