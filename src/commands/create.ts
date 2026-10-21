/**
 * `create`. A new note from markdown, converted with @overnote/core. `current` keeps naming the
 * note it named unless `--open` shows the new note.
 */
import { displayTitle } from "@overnote/core/text";

import { flagBoolean, flagString, ok, type CommandSpec } from "../command.js";
import type { Context } from "../context.js";
import type { Note, NotesWriter } from "../domain/types.js";
import { AxiError, axiError, validation } from "../errors.js";
import { joinBlocks, renderDetail, renderHelp } from "../output/render.js";
import { readContent } from "./content.js";
import { keepCurrent, pinPosition, storedCurrent } from "./note-ops.js";
import { CONTENT_FLAGS } from "./shared.js";

/** The confirmation `create` and `duplicate` print for a new note. */
export function renderNewNote(
  label: "created" | "duplicated",
  note: Note,
  extra: Record<string, string | number> = {},
  warning?: string,
): string {
  return joinBlocks([
    renderDetail({ [label]: { id: note.id, title: displayTitle(note), ...extra, updatedAt: note.updatedAt }, warning }),
    renderHelp([`overnote-axi read ${note.id}`, `overnote-axi update ${note.id} --content "<markdown>"`]),
  ]);
}

/**
 * Pins a note that was just created and returns its place in the pinned list (`?` when the
 * read after the pin cannot find it). A failed pin names the new note, so a retry pins it
 * instead of creating a second one.
 */
async function pinNew(context: Context, writer: NotesWriter, note: Note): Promise<{ note: Note; pinned: number | string }> {
  try {
    const pinned = await writer.pin(note.id);
    return { note: pinned, pinned: pinPosition(context, note.id).position ?? "?" };
  } catch (error) {
    const cause = error instanceof AxiError ? error : null;
    throw axiError(
      `created ${note.id}, but pinning it failed${cause ? ` (${cause.message})` : ""}; do not create it again`,
      cause?.code ?? "HELPER_ERROR",
      [`overnote-axi pin ${note.id}`, `overnote-axi read ${note.id}`],
      { id: note.id },
    );
  }
}

export const command: CommandSpec = {
  name: "create",
  positionals: [],
  flags: [
    ...CONTENT_FLAGS,
    { name: "title", type: "string", value: "<text>", description: "Heading placed above the content as # <text>" },
    { name: "pin", type: "boolean", description: "Pin the new note" },
    { name: "open", type: "boolean", description: "Show the new note in the Overnote panel (it becomes the current note)" },
  ],
  notes: [
    "The title is the first line of the note, as in the app",
    "Give --title, --content, or both",
    "current keeps naming the same note unless --open",
  ],
  examples: [
    'overnote-axi create --title "Standup" --content "- [ ] demo"',
    "overnote-axi create --content-file notes.md --pin",
    'printf "# Draft" | overnote-axi create --content -',
  ],
  run: async (args, context) => {
    const rawTitle = flagString(args, "title");
    const title = rawTitle?.trim();
    if (title !== undefined && title === "") {
      throw validation("create --title must not be blank", ['overnote-axi create --title "<text>" --content "<markdown>"']);
    }
    if (title !== undefined && /[\r\n]/.test(title)) {
      throw validation("create --title must be a single line", ['overnote-axi create --title "<text>" --content "<markdown>"']);
    }
    const body = await readContent(args, context);
    const parts = [title ? `# ${title}` : "", body ?? ""].filter((part) => part.trim() !== "");
    if (parts.length === 0) {
      throw validation("a new note needs --title or content", [
        'overnote-axi create --title "<text>"',
        'overnote-axi create --content "<markdown>"',
      ]);
    }

    // Connect first, so a stopped helper fails before the core chunk loads.
    const writer = await context.writer();
    const content = (await context.converter()).fromMarkdown(parts.join("\n\n"));
    const open = flagBoolean(args, "open");
    const previous = open ? null : storedCurrent(context);
    let note = await writer.create(content, open ? { show: true } : {});
    const warning = open ? undefined : await keepCurrent(context, writer, previous, note.id);
    if (!flagBoolean(args, "pin")) return ok(renderNewNote("created", note, {}, warning));
    const pinned = await pinNew(context, writer, note);
    note = pinned.note;
    return ok(renderNewNote("created", note, { pinned: pinned.pinned }, warning));
  },
};
