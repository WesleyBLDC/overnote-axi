/**
 * The one content write path that `update`, `edit`, and `link --into` share (slice: write
 * commands). See docs/DESIGN.md section 7 "Safety model for writes".
 *
 * Steps, in order:
 * 1. Resolve `<note>` from SQLite (refs.ts, `allowTrashed: false`).
 * 2. Fetch the note fresh with `notes.get` through the helper; if `deletedAt` is now set, fail
 *    with NOTE_TRASHED before composing (it may have been trashed after step 1).
 * 3. If `expectedUpdatedAt` was given and differs from the fresh `updatedAt`, fail STALE_WRITE.
 * 4. Call `plan(fresh, converter)`; `null` means the desired state is already there (`(no-op)`).
 * 5. If the plan reports losses and `allowLoss` is false, fail LOSSY_REWRITE with the losses.
 * 6. `notes.update` with `expectedUpdatedAt` = the fresh `updatedAt`; a conflict is STALE_WRITE.
 * 7. If the target is the note open in Overnote (`currentNoteId`), add the warning field and,
 *    after VERIFY_DELAY_MS (past the editor's 300 ms autosave debounce), re-read it with
 *    `notes.get`. If `updatedAt` moved and the stored rawContent is no longer what was written,
 *    fail OVERWRITTEN_BY_EDITOR (the editor's pending save won). Other notes skip the wait.
 */
import type { Context } from "../context.js";
import type { MarkdownConverter, Note, NoteContent, RewriteLoss } from "../domain/types.js";
import { notImplemented } from "../errors.js";

/** Past the editor's 300 ms autosave debounce (overnote docs/architecture.md section 5). */
export const VERIFY_DELAY_MS = 400;

/** Shown when the target is the note open in Overnote. */
export const OPEN_NOTE_WARNING = "note is open in Overnote; unsaved edits there win over this write";

export interface PlannedWrite {
  content: NoteContent;
  /** From MarkdownConverter.rewriteLosses or EditOutcome.losses; empty for append and prepend. */
  losses: readonly RewriteLoss[];
  /** Extra confirmation fields for the command's output (for example `replaced: 2`). */
  details?: Readonly<Record<string, string | number>>;
}

export interface WriteRequest {
  /** The raw `<note>` argument. */
  ref: string;
  expectedUpdatedAt?: number;
  allowLoss: boolean;
  plan: (fresh: Note, converter: MarkdownConverter) => PlannedWrite | null;
}

export type WriteOutcome =
  | { status: "written"; note: Note; details: Readonly<Record<string, string | number>>; warning?: string }
  | { status: "no-op"; note: Note };

export async function writeContent(_context: Context, _request: WriteRequest): Promise<WriteOutcome> {
  throw notImplemented("writeContent");
}
