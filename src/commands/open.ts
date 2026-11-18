/**
 * `open [note]`. Shows Overnote's panel, on a note or the last one:
 * - through the running helper (`window.show`), whether Overnote.app or the Raycast extension runs it;
 * - else by starting Overnote.app when it is installed, then the same `window.show`;
 * - else through the Raycast extension's deeplink, which starts the extension's helper.
 */
import { displayTitle } from "@overnote/core/text";

import { ok, type CommandSpec } from "../command.js";
import type { Context } from "../context.js";
import { noteDeeplink, openNotesDeeplink } from "../domain/deeplink.js";
import type { NoteId } from "../domain/types.js";
import { AxiError, axiError } from "../errors.js";
import { renderDetail } from "../output/render.js";
import { resolveNote } from "../store/refs.js";
import { NOTE_ARG } from "./shared.js";

/** How long a freshly started Overnote.app gets to answer on its socket. */
export const APP_START_TIMEOUT_MS = 5000;
const APP_START_POLL_MS = 200;

/** Opens the deeplink, giving a bare IO_ERROR from the opener the hints that fix it. */
async function openDeeplink(context: Context, url: string): Promise<void> {
  try {
    await context.openUrl(url);
  } catch (error) {
    if (error instanceof AxiError && error.code === "IO_ERROR" && error.suggestions.length === 0) {
      throw axiError(error.message, error.code, [
        "Install Overnote.app (npm run app:install in the Overnote checkout), or enable the Overnote Raycast extension",
        "overnote-axi status",
      ]);
    }
    throw error;
  }
}

async function waitForHelper(context: Context): Promise<void> {
  for (let waited = 0; waited < APP_START_TIMEOUT_MS; waited += APP_START_POLL_MS) {
    if ((await context.probeHelper()).state === "running") return;
    await context.sleep(APP_START_POLL_MS);
  }
  throw axiError("Overnote.app started but did not answer", "HELPER_NOT_RUNNING", [
    "Try again in a moment: overnote-axi open",
    "overnote-axi status",
  ]);
}

async function show(context: Context, id?: NoteId): Promise<void> {
  if ((await context.probeHelper()).state !== "running") {
    const app = context.findApp();
    if (!app) return openDeeplink(context, id === undefined ? openNotesDeeplink() : noteDeeplink(id));
    await context.openApp(app);
    await waitForHelper(context);
  }
  await (await context.writer()).show(id);
}

export const command: CommandSpec = {
  name: "open",
  positionals: [{ ...NOTE_ARG, required: false }],
  flags: [],
  notes: [
    "Opening Overnote also starts it when it is not running (Overnote.app, else the Raycast extension), which writes need",
    "A note in Recently Deleted cannot be opened; recover it first",
  ],
  examples: ["overnote-axi open", "overnote-axi open current"],
  run: async (args, context) => {
    const ref = args.positionals[0];
    if (ref === undefined) {
      await show(context);
      return ok(renderDetail({ opened: "Overnote" }));
    }
    const note = context
      .reader()
      .snapshot((reader) => resolveNote(reader, ref, { allowTrashed: false, command: "open" }));
    await show(context, note.id);
    return ok(renderDetail({ opened: `${note.id} ${displayTitle(note)}` }));
  },
};
