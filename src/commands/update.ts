/**
 * `update <note>`. Append by default; prepend below the title line, or `--top` above it;
 * replace behind the guard. Goes through writeContent (src/commands/write-flow.ts) with
 * converter.compose for append, prepend and top, and fromMarkdown plus rewriteLosses for replace.
 */
import { displayTitle } from "@overnote/core/text";

import { shellQuote } from "../args.js";
import { flagBoolean, flagNumber, ok, type CommandSpec } from "../command.js";
import { validation } from "../errors.js";
import { codePoints, joinBlocks, renderDetail } from "../output/render.js";
import { requireContent } from "./content.js";
import { noOp } from "./note-ops.js";
import { ALLOW_LOSS_FLAG, CONTENT_FLAGS, EXPECTED_UPDATED_AT_FLAG, NOTE_ARG } from "./shared.js";
import { planAddition, writeContent, type PlannedWrite } from "./write-flow.js";

export type UpdateMode = "append" | "prepend" | "top" | "replace";

const MODES: readonly UpdateMode[] = ["append", "prepend", "top", "replace"];

const NO_OP_REASON: Readonly<Record<UpdateMode, string>> = {
  append: "the note already ends with this content",
  prepend: "the note already starts with this content",
  top: "the note already starts with this content",
  replace: "the note already has exactly this content",
};

export const command: CommandSpec = {
  name: "update",
  positionals: [NOTE_ARG],
  flags: [
    ...CONTENT_FLAGS,
    { name: "append", type: "boolean", description: "Add after the existing content (the default)" },
    { name: "prepend", type: "boolean", description: "Add at the start, below the title line when the note has one" },
    { name: "top", type: "boolean", description: "Add above everything, the title line included (the content becomes the title)" },
    { name: "replace", type: "boolean", description: "Replace the whole note (needs --expected-updated-at)" },
    EXPECTED_UPDATED_AT_FLAG,
    ALLOW_LOSS_FLAG,
  ],
  notes: [
    "Append, prepend and top keep every existing block exactly as stored",
    "Adding text the note already ends with (or, for prepend, starts with) is a no-op",
    "A write that changes the note's title says so in warning, since title: references then need the new title",
    "--replace refuses with LOSSY_REWRITE when markdown cannot hold the note's content",
    "A note edited since --expected-updated-at fails with STALE_WRITE and changes nothing",
  ],
  examples: [
    'overnote-axi update RN7Q3K --content "- [ ] call Sam"',
    'overnote-axi update RN7Q3K --prepend --content "**Today:** ship the release"',
    "overnote-axi update RN7Q3K --replace --content-file note.md --expected-updated-at 1792543271491",
  ],
  run: async (args, context) => {
    const ref = args.positionals[0]!;
    const quoted = shellQuote(ref);
    const given = MODES.filter((mode) => flagBoolean(args, mode));
    if (given.length > 1) {
      throw validation(`choose one of --append, --prepend, --top, --replace (got ${given.map((mode) => `--${mode}`).join(" ")})`, [
        "overnote-axi update --help",
      ]);
    }
    const mode: UpdateMode = given[0] ?? "append";
    const expectedUpdatedAt = flagNumber(args, "expected-updated-at");
    if (mode === "replace" && expectedUpdatedAt === undefined) {
      throw validation("update --replace needs --expected-updated-at, so it cannot overwrite edits made since you read the note", [
        `overnote-axi read ${quoted} --meta`,
        `overnote-axi update ${quoted} --replace --content-file <path> --expected-updated-at <updatedAt>`,
      ]);
    }
    const addition = await requireContent(args, context, "update");

    const outcome = await writeContent(context, {
      command: "update",
      ref,
      allowLoss: flagBoolean(args, "allow-loss"),
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      lossHints: ["Repeat the same update with --allow-loss to write anyway"],
      plan: (fresh, converter): PlannedWrite | null => {
        if (mode === "replace") {
          return { content: converter.fromMarkdown(addition), losses: converter.rewriteLosses(fresh) };
        }
        return planAddition(fresh, converter, addition, mode);
      },
    });

    const { note } = outcome;
    return ok(
      joinBlocks([
        renderDetail({
          updated: {
            id: note.id,
            title: displayTitle(note),
            mode,
            chars: codePoints(note.text),
            updatedAt: note.updatedAt,
            ...(outcome.status === "written" ? outcome.details : { result: noOp(NO_OP_REASON[mode]) }),
          },
          warning: outcome.status === "written" ? outcome.warning : undefined,
        }),
      ]),
    );
  },
};
