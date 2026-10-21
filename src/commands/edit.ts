/**
 * `edit <note>`. Exact text replacement inside the markdown, block scoped through
 * converter.edit, written through writeContent (src/commands/write-flow.ts).
 *
 * A retry of a whole line edit is idempotent: when `--old` is gone and `--new` is there once as
 * whole lines (`alreadyEdited` in src/markdown/compose.ts), the edit already landed and the
 * result is a no-op. `--old` equal to `--new` runs every check (the guard, the
 * presence of `--old`, ambiguity) and then writes nothing.
 */
import { displayTitle } from "@overnote/core/text";

import { rebuildInvocation, shellQuote } from "../args.js";
import { flagBoolean, flagNumber, flagString, ok, type CommandSpec } from "../command.js";
import { axiError, validation } from "../errors.js";
import { alreadyEdited } from "../markdown/compose.js";
import { joinBlocks, renderDetail } from "../output/render.js";
import { noOp } from "./note-ops.js";
import { ALLOW_LOSS_FLAG, EXPECTED_UPDATED_AT_FLAG, NOTE_ARG } from "./shared.js";
import { writeContent } from "./write-flow.js";

export const command: CommandSpec = {
  name: "edit",
  positionals: [NOTE_ARG],
  flags: [
    { name: "old", type: "string", value: "<text>", description: "Exact markdown to find (required)" },
    { name: "new", type: "string", value: "<text>", description: "Replacement markdown; --new= deletes (required)" },
    { name: "all", type: "boolean", description: "Replace every occurrence instead of exactly one" },
    EXPECTED_UPDATED_AT_FLAG,
    ALLOW_LOSS_FLAG,
  ],
  notes: [
    "Matches the markdown that read shows, so copy text from read output",
    "Only the blocks that contain the match are rewritten; the rest of the note is untouched",
    "A retry of a whole line edit that already landed (--old gone, --new there once as whole lines, no --all) is a no-op",
  ],
  examples: [
    'overnote-axi edit current --old "- [ ] ship" --new "- [x] ship"',
    'overnote-axi edit RN7Q3K --old "2025" --new "2026" --all',
  ],
  run: async (args, context) => {
    const ref = args.positionals[0]!;
    const quoted = shellQuote(ref);
    const oldText = flagString(args, "old");
    const newText = flagString(args, "new");
    const usage = 'overnote-axi edit <note> --old "<exact markdown>" --new "<markdown>"';
    if (oldText === undefined || oldText === "") {
      throw validation("edit needs --old with the exact markdown to replace", [usage, `overnote-axi read ${quoted} --full`]);
    }
    if (newText === undefined) {
      throw validation("edit needs --new (pass --new= to delete the text)", [usage]);
    }
    const all = flagBoolean(args, "all");
    const expectedUpdatedAt = flagNumber(args, "expected-updated-at");
    let reason = "the edit leaves the note unchanged";

    const outcome = await writeContent(context, {
      command: "edit",
      ref,
      allowLoss: flagBoolean(args, "allow-loss"),
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      lossHints: [rebuildInvocation(command, args, { "allow-loss": true })],
      plan: (fresh, converter) => {
        const result = converter.edit(fresh, oldText, newText, all);
        if (result.status === "not-found") {
          const markdown = converter.current(fresh).markdown;
          if (alreadyEdited(markdown, newText, { oldText, all, normalizedNew: converter.normalize(newText) })) {
            reason = "already applied since --old is gone and --new is there once as whole lines";
            return null;
          }
          throw axiError("the --old text is not in the note", "TEXT_NOT_FOUND", [`overnote-axi read ${fresh.id} --full`], {
            id: fresh.id,
          });
        }
        if (result.status === "ambiguous") {
          throw axiError(`the --old text occurs ${result.matches} times`, "AMBIGUOUS_TEXT", [
            "Add surrounding text to --old so it matches once",
            rebuildInvocation(command, args, { all: true }),
          ], { matches: result.matches });
        }
        if (oldText === newText) {
          reason = "--old and --new are the same";
          return null;
        }
        return {
          content: result.content,
          losses: result.losses,
          details: { replaced: result.replaced, ...(result.scope === "document" ? { scope: "whole note" } : {}) },
        };
      },
    });

    const { note } = outcome;
    const title = displayTitle(note);
    return ok(
      joinBlocks([
        renderDetail({
          edited:
            outcome.status === "written"
              ? { id: note.id, title, ...outcome.details, updatedAt: note.updatedAt }
              : { id: note.id, title, replaced: 0, updatedAt: note.updatedAt, result: noOp(reason) },
          warning: outcome.status === "written" ? outcome.warning : undefined,
        }),
      ]),
    );
  },
};
