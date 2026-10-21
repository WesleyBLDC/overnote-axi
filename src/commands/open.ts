/** `open [note]`. Shows a note, or the last one, via a Raycast deeplink. */
import { displayTitle } from "@overnote/core/text";

import { ok, type CommandSpec } from "../command.js";
import type { Context } from "../context.js";
import { noteDeeplink, openNotesDeeplink } from "../domain/deeplink.js";
import { AxiError, axiError } from "../errors.js";
import { renderDetail } from "../output/render.js";
import { resolveNote } from "../store/refs.js";
import { NOTE_ARG } from "./shared.js";

/** Opens the URL, giving a bare IO_ERROR from the opener the hints that fix it. */
async function openOrExplain(context: Context, url: string): Promise<void> {
  try {
    await context.openUrl(url);
  } catch (error) {
    if (error instanceof AxiError && error.code === "IO_ERROR" && error.suggestions.length === 0) {
      throw axiError(error.message, error.code, [
        "Check that Raycast is installed and the Overnote extension is enabled",
        "overnote-axi status",
      ]);
    }
    throw error;
  }
}

export const command: CommandSpec = {
  name: "open",
  positionals: [{ ...NOTE_ARG, required: false }],
  flags: [],
  notes: ["Opening Overnote also starts its helper, which writes need", "A note in Recently Deleted cannot be opened; recover it first"],
  examples: ["overnote-axi open", "overnote-axi open current"],
  run: async (args, context) => {
    const ref = args.positionals[0];
    if (ref === undefined) {
      await openOrExplain(context, openNotesDeeplink());
      return ok(renderDetail({ opened: "Overnote" }));
    }
    const note = context.reader().snapshot((reader) => resolveNote(reader, ref, { allowTrashed: false, command: "open" }));
    await openOrExplain(context, noteDeeplink(note.id));
    return ok(renderDetail({ opened: `${note.id} ${displayTitle(note)}` }));
  },
};
