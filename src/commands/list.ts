/** `list`. Live notes in app order: pinned first, then newest. */
import { flagBoolean, flagList, flagNumber, flagString, type CommandSpec } from "../command.js";
import type { ListOrder } from "../domain/types.js";
import { pagedListing } from "./listing.js";
import { listColumns, needsPinPositions, pinPositions, type ListField } from "./note-columns.js";
import { DEFAULT_LIST_FIELDS, fieldsFlag, LIST_FIELDS, limitFlag, OFFSET_FLAG } from "./shared.js";

export const DEFAULT_LIST_LIMIT = 50;

export const command: CommandSpec = {
  name: "list",
  positionals: [],
  flags: [
    limitFlag(DEFAULT_LIST_LIMIT),
    OFFSET_FLAG,
    { name: "pinned", type: "boolean", description: "Only pinned notes, in pin order" },
    {
      name: "sort",
      type: "string",
      value: "<order>",
      choices: ["updated", "accessed", "created"],
      default: "updated",
      description: "Order after the pinned notes, newest first",
    },
    fieldsFlag(LIST_FIELDS, DEFAULT_LIST_FIELDS),
  ],
  examples: ["overnote-axi list", "overnote-axi list --pinned", "overnote-axi list --sort accessed --fields id,title,accessed"],
  run: async (args, context) => {
    const limit = flagNumber(args, "limit") ?? DEFAULT_LIST_LIMIT;
    const offset = flagNumber(args, "offset") ?? 0;
    const pinnedOnly = flagBoolean(args, "pinned");
    // The parser only lets through the declared choices.
    const order = (flagString(args, "sort") ?? "updated") as ListOrder;
    const fields = (flagList(args, "fields") ?? DEFAULT_LIST_FIELDS) as readonly ListField[];

    const { page, positions } = context.reader().snapshot((reader) => ({
      page: reader.list({ limit, offset, pinnedOnly, order }),
      positions: needsPinPositions(fields) ? pinPositions(reader) : new Map(),
    }));

    return pagedListing({
      spec: command,
      args,
      page,
      offset,
      label: "notes",
      noun: pinnedOnly ? "pinned notes" : "live notes",
      columns: listColumns(fields, positions),
      emptyHints: pinnedOnly ? ["overnote-axi pin <id>", "overnote-axi list"] : ['overnote-axi create --content "<markdown>"'],
      rowHints: ["overnote-axi read <id>"],
    });
  },
};
