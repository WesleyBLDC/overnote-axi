/** `read <note>...`. Metadata plus markdown, truncated unless --full. */
import { displayTitle } from "@overnote/core/text";

import { rebuildInvocation } from "../args.js";
import { flagBoolean, flagString, ok, type CommandSpec } from "../command.js";
import { extractNoteLinks } from "../domain/deeplink.js";
import type { Note, NoteId, NotesReader } from "../domain/types.js";
import {
  codePoints,
  isoDate,
  isoMinute,
  joinBlocks,
  renderDetail,
  renderHelp,
  renderTextBlock,
  truncate,
  TRUNCATE_LIMIT,
} from "../output/render.js";
import { resolveNote } from "../store/refs.js";
import { pinPositions, type PinPositions } from "./note-columns.js";
import { NOTE_ARG } from "./shared.js";

export type BodyFormat = "markdown" | "text";

interface NoteView {
  note: Note;
  outgoing: number;
  incoming: number;
}

/** Resolves every reference in order (duplicates once) and gathers link counts, in one snapshot. */
function gather(reader: NotesReader, refs: readonly string[]): { views: NoteView[]; positions: PinPositions } {
  return reader.snapshot((snap) => {
    const seen = new Set<NoteId>();
    const views: NoteView[] = [];
    for (const ref of refs) {
      const note = resolveNote(snap, ref, { allowTrashed: true });
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      views.push({ note, outgoing: extractNoteLinks(note.markdown).length, incoming: snap.backlinks(note.id).length });
    }
    return { views, positions: pinPositions(snap) };
  });
}

function metadata(view: NoteView, positions: PinPositions): Record<string, unknown> {
  const { note } = view;
  const trashed = note.deletedAt !== null;
  return {
    id: note.id,
    title: displayTitle(note),
    state: trashed ? "trashed" : "live",
    pinned: positions.get(note.id),
    deleted: note.deletedAt === null ? undefined : isoDate(note.deletedAt),
    updated: isoMinute(note.updatedAt),
    updatedAt: note.updatedAt,
    created: isoDate(note.createdAt),
    chars: codePoints(note.text),
    links: `${view.outgoing} out, ${view.incoming} in`,
  };
}

export const command: CommandSpec = {
  name: "read",
  positionals: [{ ...NOTE_ARG, variadic: true }],
  flags: [
    { name: "full", type: "boolean", description: "Do not truncate the body" },
    { name: "meta", type: "boolean", description: "Metadata only, no body" },
    {
      name: "format",
      type: "string",
      value: "<format>",
      choices: ["markdown", "text"],
      default: "markdown",
      description: "Body as markdown or as plain text",
    },
  ],
  notes: [
    "updatedAt is the value to pass as --expected-updated-at to update and edit",
    `Bodies stop at ${TRUNCATE_LIMIT} characters unless --full`,
  ],
  examples: ["overnote-axi read current", "overnote-axi read RN7Q3K --full", "overnote-axi read title:Groceries --meta"],
  run: async (args, context) => {
    const full = flagBoolean(args, "full");
    const meta = flagBoolean(args, "meta");
    const format = (flagString(args, "format") ?? "markdown") as BodyFormat;
    const { views, positions } = gather(context.reader(), args.positionals);

    const blocks: string[] = [];
    if (views.length > 1) blocks.push(renderDetail({ count: `${views.length} notes` }));
    const truncated: NoteId[] = [];
    for (const view of views) {
      blocks.push(renderDetail({ note: metadata(view, positions) }));
      if (meta) continue;
      const body = truncate(format === "markdown" ? view.note.markdown : view.note.text, full, TRUNCATE_LIMIT, `${format} chars`);
      if (body.truncated) truncated.push(view.note.id);
      // A body of only blank lines reads as empty, not as a label with nothing under it.
      blocks.push(renderTextBlock(format, body.text.trim() === "" ? "" : body.text));
    }
    if (truncated.length > 0) {
      blocks.push(renderHelp([rebuildInvocation(command, { ...args, positionals: truncated }, { full: true })]));
    }
    return ok(joinBlocks(blocks));
  },
};
