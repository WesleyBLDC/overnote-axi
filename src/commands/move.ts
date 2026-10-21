/** `move <note> up|down`. Reorders the pinned list; no-op at the ends. */
import { flagNumber, ok, type CommandSpec } from "../command.js";
import type { PinDirection } from "../domain/types.js";
import { axiError } from "../errors.js";
import { renderDetail } from "../output/render.js";
import { trashedError } from "../store/refs.js";
import { noteLabel, pinPosition, resolveFresh } from "./note-ops.js";
import { NOTE_ARG } from "./shared.js";

export const command: CommandSpec = {
  name: "move",
  positionals: [NOTE_ARG, { name: "<direction>", description: "Where to move it", required: true, choices: ["up", "down"] }],
  flags: [
    {
      name: "steps",
      type: "number",
      value: "<n>",
      min: 1,
      max: 100,
      default: "1",
      description: "Positions to move",
    },
  ],
  notes: ["Only pinned notes have an order; at the top or bottom the move stops and reports where it ended"],
  examples: ["overnote-axi move RN7Q3K up", "overnote-axi move current down --steps 2"],
  run: async (args, context) => {
    const direction = args.positionals[1] as PinDirection;
    const steps = flagNumber(args, "steps") ?? 1;
    const { writer, note } = await resolveFresh(context, args.positionals[0]!, "move");
    if (note.deletedAt !== null) throw trashedError(note);
    const start = pinPosition(context, note.id);
    if (note.pinned === null || start.position === null) {
      throw axiError(`${noteLabel(note)} is not pinned`, "NOT_PINNED", [`overnote-axi pin ${note.id}`], { id: note.id });
    }

    const room = direction === "up" ? start.position - 1 : start.total - start.position;
    const moves = Math.min(steps, room);
    const edge = direction === "up" ? "top" : "bottom";
    if (moves === 0) {
      return ok(renderDetail({ moved: `${noteLabel(note)} (no-op; already at the ${edge} as position ${start.position} of ${start.total})` }));
    }
    for (let i = 0; i < moves; i++) await writer.movePinned(note.id, direction);
    const end = pinPosition(context, note.id);
    const stopped = moves < steps ? `; reached the ${edge} after ${moves} of ${steps} steps` : "";
    return ok(renderDetail({ moved: `${noteLabel(note)} (position ${end.position ?? "?"} of ${end.total}${stopped})` }));
  },
};
