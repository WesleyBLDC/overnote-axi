/**
 * `trash`. Lists Recently Deleted from the read-only database; `--empty --permanent` erases all
 * of it through the helper. `--empty` alone is a usage error. `--expected-count` pins what the
 * caller saw, so notes trashed after it looked are not erased unseen (docs/DESIGN.md section
 * 6.16). No hint ever offers the erase command: an agent must decide to type it.
 *
 * One window stays open: `notes.emptyTrash` takes no expected count, so a note trashed between
 * the count check and the helper call is erased too. The erased count the helper returns is
 * compared with the checked one, and any difference is reported in the output.
 */
import { flagBoolean, flagList, flagNumber, ok, type CommandOutput, type CommandSpec, type ParsedArgs } from "../command.js";
import type { Context } from "../context.js";
import { axiError, validation } from "../errors.js";
import { renderDetail } from "../output/render.js";
import { pagedListing } from "./listing.js";
import { listColumns, type ListField } from "./note-columns.js";
import { noOp } from "./note-ops.js";
import { DEFAULT_LIST_FIELDS, DEFAULT_TRASH_FIELDS, fieldsFlag, limitFlag, OFFSET_FLAG, TRASH_FIELDS } from "./shared.js";

const DEFAULT_LIMIT = 50;
const NOUN = "notes in Recently Deleted";

function plural(count: number): string {
  return `${count} note${count === 1 ? "" : "s"}`;
}

function listing(args: ParsedArgs, context: Context): CommandOutput {
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  const offset = flagNumber(args, "offset") ?? 0;
  const fields = (flagList(args, "fields") ?? DEFAULT_TRASH_FIELDS) as readonly ListField[];
  const page = context.reader().snapshot((reader) => reader.listTrashed({ limit, offset }));
  // Trashed notes are never pinned, so the pinned column is always empty and needs no query.
  return pagedListing({
    spec: command,
    args,
    page,
    offset,
    label: "trash",
    noun: NOUN,
    columns: listColumns(fields, new Map()),
    emptyHints: [],
    rowHints: ["overnote-axi recover <id>"],
  });
}

async function empty(args: ParsedArgs, context: Context): Promise<CommandOutput> {
  for (const name of ["limit", "offset", "fields"]) {
    if (args.flags[name] !== undefined) {
      throw validation(`trash --${name} applies to the listing, not to --empty`, ["overnote-axi trash"]);
    }
  }
  const count = context.reader().snapshot((reader) => reader.counts().trashed);
  if (!flagBoolean(args, "permanent")) {
    throw validation(
      `trash --empty erases ${count === 1 ? "the 1 note" : `all ${plural(count)}`} in Recently Deleted for good and needs --permanent; list them first and check that none is still needed`,
      ["overnote-axi trash"],
    );
  }
  const expected = flagNumber(args, "expected-count");
  if (expected !== undefined && expected !== count) {
    throw axiError(
      `Recently Deleted holds ${plural(count)}, not ${expected}; nothing was erased`,
      "STALE_WRITE",
      ["overnote-axi trash"],
      { count },
    );
  }
  if (count === 0) return ok(renderDetail({ emptied: `0 notes erased ${noOp("Recently Deleted is empty")}` }));
  const erased = await (await context.writer()).emptyTrash();
  const differs = erased === count ? "" : ` (${plural(count)} checked before; the trash changed meanwhile)`;
  return ok(renderDetail({ emptied: `${plural(erased)} erased${differs}` }));
}

export const command: CommandSpec = {
  name: "trash",
  positionals: [],
  flags: [
    limitFlag(DEFAULT_LIMIT),
    OFFSET_FLAG,
    fieldsFlag(TRASH_FIELDS, DEFAULT_TRASH_FIELDS),
    { name: "empty", type: "boolean", description: "Erase every note in Recently Deleted (needs --permanent)" },
    { name: "permanent", type: "boolean", description: "Confirms that --empty erases notes for good" },
    {
      name: "expected-count",
      type: "number",
      value: "<n>",
      min: 0,
      description: "With --empty, refuse unless Recently Deleted still holds exactly this many notes",
    },
  ],
  notes: [
    `Default columns: ${DEFAULT_TRASH_FIELDS.join(",")} (list defaults are ${DEFAULT_LIST_FIELDS.join(",")})`,
    "Notes in Recently Deleted are erased by the app after 60 days",
  ],
  examples: ["overnote-axi trash", "overnote-axi trash --empty --permanent --expected-count 5"],
  run: async (args, context) => {
    if (flagBoolean(args, "empty")) return empty(args, context);
    for (const name of ["permanent", "expected-count"]) {
      if (args.flags[name] !== undefined) {
        throw validation(`trash --${name} only applies with --empty`, ["overnote-axi trash"]);
      }
    }
    return listing(args, context);
  },
};
