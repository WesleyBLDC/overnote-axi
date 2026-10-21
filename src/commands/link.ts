/**
 * `link <note>`. Print a note's markdown link, or insert it with --into through
 * writeContent and converter.compose (never a markdown rewrite of the target).
 */
import { displayTitle } from "@overnote/core/text";

import { shellQuote } from "../args.js";
import { flagBoolean, flagString, ok, type CommandSpec } from "../command.js";
import { escapeLinkText, noteDeeplink } from "../domain/deeplink.js";
import type { Note, NoteId } from "../domain/types.js";
import { AxiError, axiError, validation } from "../errors.js";
import { renderDetail } from "../output/render.js";
import { resolveNote } from "../store/refs.js";
import { noOp } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";
import { planAddition, writeContent } from "./write-flow.js";

/** `[Title](raycast://...)`: the markdown link, which carries the deeplink once. */
function linkMarkdown(linked: Note, text: string | undefined): string {
  return `[${escapeLinkText(text ?? displayTitle(linked))}](${noteDeeplink(linked.id)})`;
}

function linkFields(linked: Note, text: string | undefined): { id: NoteId; markdown: string } {
  return { id: linked.id, markdown: linkMarkdown(linked, text) };
}

/** The linked note, which writeContent's inspect step always sets before plan runs. */
function resolved(linked: Note | undefined): Note {
  if (linked === undefined) throw new Error("link: the linked note was not resolved before planning");
  return linked;
}

export const command: CommandSpec = {
  name: "link",
  positionals: [NOTE_ARG],
  flags: [
    { name: "into", type: "string", value: "<note>", description: "Insert the link into this note" },
    { name: "text", type: "string", value: "<label>", description: "Link text (default: the linked note's title)" },
    { name: "prepend", type: "boolean", description: "Insert at the start (below the title line) instead of the end" },
  ],
  notes: ["Links open the note in Overnote through Raycast"],
  examples: ["overnote-axi link RN7Q3K", "overnote-axi link RN7Q3K --into current"],
  run: async (args, context) => {
    const ref = args.positionals[0]!;
    const quoted = shellQuote(ref);
    const into = flagString(args, "into");
    const text = flagString(args, "text");
    const prepend = flagBoolean(args, "prepend");
    if (into !== undefined && into.trim() === "") throw validation("link --into needs a note", [`overnote-axi link ${quoted} --into current`]);
    if (text !== undefined && text.trim() === "") throw validation("link --text must not be empty", [`overnote-axi link ${quoted}`]);
    if (prepend && into === undefined) {
      throw validation("link --prepend only applies with --into", [`overnote-axi link ${quoted} --into <note> --prepend`]);
    }

    if (into === undefined) {
      // Printing a link reads only, so a trashed note still gets its link.
      const linked = context.reader().snapshot((reader) => resolveNote(reader, ref, { allowTrashed: true, command: "link" }));
      return ok(renderDetail({ link: linkFields(linked, text) }));
    }

    // Inserting resolves the linked note in writeContent's snapshot, so the command sees one
    // database state; it refuses a trashed note, which would be a dead link.
    const mode = prepend ? "prepend" : "append";
    let linked: Note | undefined;
    let targetResolved = false;
    const outcome = await writeContent(context, {
      command: "link",
      ref: into,
      allowLoss: false,
      inspect: (reader, target) => {
        targetResolved = true;
        const found = resolveNote(reader, ref, { allowTrashed: false, command: "link" });
        if (target.id === found.id) {
          throw validation("a note cannot link into itself", [`overnote-axi link ${found.id} --into <other note>`]);
        }
        linked = found;
      },
      plan: (fresh, converter) => planAddition(fresh, converter, linkMarkdown(resolved(linked), text), mode),
    }).catch((error: unknown) => {
      // Only the target's resolution names --into, and its hints keep the linked note and the
      // --into flag; a missing linked note keeps its own error.
      if (!targetResolved && error instanceof AxiError && (error.code === "NOTE_NOT_FOUND" || error.code === "VALIDATION_ERROR")) {
        const words = into.trim().replace(/^title:/i, "").trim();
        const hints = [
          ...(words === ""
            ? []
            : [`overnote-axi search ${shellQuote(words)}`, `overnote-axi link ${quoted} --into ${shellQuote(`title:${words}`)}`]),
          "overnote-axi list",
        ];
        if (error.code === "VALIDATION_ERROR") throw validation(error.message, hints);
        throw axiError(`no note matches --into '${into}'`, "NOTE_NOT_FOUND", hints);
      }
      throw error;
    });

    const { note } = outcome;
    const linkedBlock = {
      id: resolved(linked).id,
      into: note.id,
      title: displayTitle(note),
      at: prepend ? "start" : "end",
      ...(outcome.status === "no-op" ? { result: noOp(`the note already ${prepend ? "starts" : "ends"} with this link`) } : {}),
      updatedAt: note.updatedAt,
    };
    return ok(renderDetail({ linked: linkedBlock, warning: outcome.status === "written" ? outcome.warning : undefined }));
  },
};
