/**
 * The one content write path that `update`, `edit`, and `link --into` share. See docs/DESIGN.md
 * section 7 "Safety model for writes".
 *
 * Steps, in order:
 * 1. Resolve `<note>` from SQLite (refs.ts, `allowTrashed: false`), in one snapshot that also
 *    finds the note Overnote shows and runs the command's own `inspect` reads.
 * 2. Fetch the note fresh with `notes.get` through the helper; if `deletedAt` is now set, fail
 *    with NOTE_TRASHED before composing (it may have been trashed after step 1).
 * 3. If `expectedUpdatedAt` was given and differs from the fresh `updatedAt`, fail STALE_WRITE.
 * 4. Call `plan(fresh, converter)`; `null` means the desired state is already there (`(no-op)`).
 * 5. If the plan reports losses and `allowLoss` is false, fail LOSSY_REWRITE with the losses.
 * 6. `notes.update` with `expectedUpdatedAt` = the fresh `updatedAt`; a conflict is STALE_WRITE.
 * 7. If the target is the note open in Overnote, add the warning field and, after
 *    VERIFY_DELAY_MS (past the editor's 300 ms autosave debounce), re-read it with `notes.get`.
 *    If `updatedAt` moved and the write no longer stands in the stored document, fail
 *    OVERWRITTEN_BY_EDITOR: an editor that does not merge saved its older content over it.
 *    An editor that merges keeps the write's blocks, so its save passes the check
 *    (`MarkdownConverter.writeSurvived`). Other notes skip the wait.
 * 8. If the write changed the note's display title, add `title changed from 'X' to 'Y'` to the
 *    warning, because `title:` references to the old title stop matching.
 */
import { displayTitle } from "@overnote/core/text";

import type { Context } from "../context.js";
import type { ComposeMode, MarkdownConverter, Note, NoteContent, NoteId, NotesReader, RewriteLoss } from "../domain/types.js";
import { axiError } from "../errors.js";
import { alreadyPresent } from "../markdown/compose.js";
import { resolveNote, trashedError } from "../store/refs.js";

/** Past the editor's 300 ms autosave debounce (overnote docs/architecture.md section 5). */
export const VERIFY_DELAY_MS = 400;

/** Shown when the target is the note open in Overnote. */
export const OPEN_NOTE_WARNING = "note is open in Overnote; unsaved edits there can win over this write";

export type WriteDetails = Readonly<Record<string, string | number>>;

export interface PlannedWrite {
  content: NoteContent;
  /** From MarkdownConverter.rewriteLosses or EditOutcome.losses; empty for append and prepend. */
  losses: readonly RewriteLoss[];
  /** Extra confirmation fields for the command's output (for example `replaced: 2`). */
  details?: WriteDetails;
}

export interface WriteRequest {
  /** The command name, for reference error hints. */
  command: string;
  /** The raw `<note>` argument. */
  ref: string;
  expectedUpdatedAt?: number;
  allowLoss: boolean;
  /**
   * Extra reads inside the same snapshot as the resolution (for example `link --into` resolving
   * the linked note), so one command sees one database state. May throw an AxiError.
   */
  inspect?: (reader: NotesReader, target: Note) => void;
  /** Help lines for LOSSY_REWRITE, after the generic advice (for example the same command with --allow-loss). */
  lossHints?: readonly string[];
  plan: (fresh: Note, converter: MarkdownConverter) => PlannedWrite | null;
}

export type WriteOutcome =
  | { status: "written"; note: Note; details: WriteDetails; warning?: string }
  | { status: "no-op"; note: Note };

/**
 * The plan for adding `addition` to a note (update, link --into): null when it is already there,
 * so a retry is a no-op. A prepend below the title line checks the markdown below the title.
 */
export function planAddition(fresh: Note, converter: MarkdownConverter, addition: string, mode: ComposeMode): PlannedWrite | null {
  const normalized = converter.normalize(addition);
  const stored = mode === "prepend" ? (converter.belowTitle(fresh) ?? fresh.markdown) : fresh.markdown;
  if (alreadyPresent(stored, normalized, mode)) return null;
  return { content: converter.compose(fresh, addition, mode), losses: [] };
}

/** `title changed from 'Plan' to 'Today'`, or null when the display title stayed. */
function titleChange(before: Note, after: Note): string | null {
  const was = displayTitle(before);
  const is = displayTitle(after);
  return was === is ? null : `title changed from '${was}' to '${is}'`;
}

/** Joins the warnings of one write into the single `warning` field. */
function warningOf(parts: readonly (string | null)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== null);
  return present.length === 0 ? undefined : present.join("; ");
}

function staleWrite(id: NoteId, stored: number, reason: string) {
  return axiError(reason, "STALE_WRITE", [`overnote-axi read ${id}`], { updatedAt: stored });
}

/** The note Overnote shows: `currentNoteId`, or the app's fallback to the newest live note. */
function openNoteId(reader: NotesReader): NoteId | null {
  try {
    return resolveNote(reader, "current", { allowTrashed: false }).id;
  } catch {
    return null;
  }
}

export async function writeContent(context: Context, request: WriteRequest): Promise<WriteOutcome> {
  const { target, openId } = context.reader().snapshot((reader) => {
    const resolved = resolveNote(reader, request.ref, { allowTrashed: false, command: request.command });
    request.inspect?.(reader, resolved);
    return { target: resolved, openId: openNoteId(reader) };
  });

  const writer = await context.writer();
  const fresh = await writer.get(target.id);
  if (fresh.deletedAt !== null) {
    throw trashedError(fresh);
  }
  if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== fresh.updatedAt) {
    throw staleWrite(
      fresh.id,
      fresh.updatedAt,
      `the note changed after updatedAt ${request.expectedUpdatedAt}; nothing was written`,
    );
  }

  const converter = await context.converter();
  const planned = request.plan(fresh, converter);
  if (planned === null || planned.content.rawContent === fresh.rawContent) return { status: "no-op", note: fresh };

  const losses = [...planned.losses];
  if (losses.length > 0 && !request.allowLoss) {
    throw axiError(
      "rewriting this note through markdown would lose stored content; nothing was written (appending with update keeps every block)",
      "LOSSY_REWRITE",
      [`overnote-axi update ${fresh.id} --content "<markdown>"`, ...(request.lossHints ?? [])],
      { losses: losses.join(",") },
    );
  }

  const { rawContent, markdown, text, title } = planned.content;
  const result = await writer.update({ id: fresh.id, expectedUpdatedAt: fresh.updatedAt, rawContent, markdown, text, title });
  if (result.status === "conflict") {
    throw staleWrite(fresh.id, result.note.updatedAt, "the note changed while this write was prepared; nothing was written");
  }

  const details: Record<string, string | number> = { ...planned.details };
  if (losses.length > 0) details.lost = losses.join(",");
  if (fresh.id !== openId) {
    const warning = warningOf([titleChange(fresh, result.note)]);
    return { status: "written", note: result.note, details, ...(warning === undefined ? {} : { warning }) };
  }

  await context.sleep(VERIFY_DELAY_MS);
  const after = await writer.get(fresh.id);
  if (after.updatedAt !== result.note.updatedAt && !converter.writeSurvived(fresh, result.note, after)) {
    throw axiError(
      "the write landed, then the open Overnote editor saved its unsaved edits over it",
      "OVERWRITTEN_BY_EDITOR",
      [`overnote-axi read ${fresh.id}`, "Retry once the person stops typing in that note"],
      { id: fresh.id, updatedAt: after.updatedAt },
    );
  }
  return { status: "written", note: after, details, warning: warningOf([titleChange(fresh, after), OPEN_NOTE_WARNING]) ?? OPEN_NOTE_WARNING };
}
