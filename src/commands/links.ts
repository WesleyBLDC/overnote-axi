/** `links <note>`. Outgoing note deeplinks and backlinks. */
import { displayTitle } from "@overnote/core/text";

import { ok, type CommandSpec } from "../command.js";
import { extractNoteLinks } from "../domain/deeplink.js";
import type { NoteId } from "../domain/types.js";
import { column, joinBlocks, renderDetail, renderEmpty, renderHelp, renderRows } from "../output/render.js";
import { resolveNote } from "../store/refs.js";
import { summaryTitle } from "./note-columns.js";
import { NOTE_ARG } from "./shared.js";

/** The title an outgoing link shows when its target no longer exists. */
export const MISSING_TITLE = "(missing)";

interface LinkRow {
  id: NoteId;
  title: string;
}

const LINK_COLUMNS = [column<LinkRow>("id", (row) => row.id), column<LinkRow>("title", (row) => row.title)];

export const command: CommandSpec = {
  name: "links",
  positionals: [NOTE_ARG],
  flags: [],
  notes: ["Backlinks are live notes whose markdown links to this note"],
  examples: ["overnote-axi links current"],
  run: async (args, context) => {
    const { note, outgoing, backlinks } = context.reader().snapshot((reader) => {
      const found = resolveNote(reader, args.positionals[0] ?? "", { allowTrashed: true, command: "links" });
      const targets = extractNoteLinks(found.markdown).map((link): LinkRow => {
        const target = reader.get(link.id);
        return { id: link.id, title: target ? displayTitle(target) : MISSING_TITLE };
      });
      const sources = reader.backlinks(found.id).map((source): LinkRow => ({ id: source.id, title: summaryTitle(source) }));
      return { note: found, outgoing: targets, backlinks: sources };
    });

    const hints =
      outgoing.length + backlinks.length > 0
        ? ["overnote-axi read <id>"]
        : [`overnote-axi link ${note.id} --into <other note>`];
    return ok(
      joinBlocks([
        renderDetail({
          note: `${note.id} ${displayTitle(note)}`,
          state: note.deletedAt === null ? undefined : "trashed",
        }),
        outgoing.length > 0 ? renderRows("outgoing", outgoing, LINK_COLUMNS) : renderEmpty("outgoing", "0 links"),
        backlinks.length > 0 ? renderRows("backlinks", backlinks, LINK_COLUMNS) : renderEmpty("backlinks", "0 notes link here"),
        renderHelp(hints),
      ]),
    );
  },
};
