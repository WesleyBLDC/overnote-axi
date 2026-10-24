/**
 * `overnote-axi` / `overnote-axi home`. Content first (AXI principle 8): bin and description,
 * helper state, counts, the current note, pinned and recent rows, hints.
 * Never fails on a missing or unreadable database or a stopped helper: it says so in the output
 * and exits 0, because the session hook runs it at every session start. Helper state comes from
 * context.probeHelper() (short timeout, started before the reads so both overlap), and all reads
 * share one reader.snapshot().
 */
import { lstatSync } from "node:fs";

import { displayTitle } from "@overnote/core/text";

import { flagNumber, ok, type CommandSpec } from "../command.js";
import type { Context } from "../context.js";
import type { HelperProbe, Note, NoteCounts, NoteSummary, NotesReader, OvernotePaths } from "../domain/types.js";
import { isTrustedRuntimeDir, isTrustedSocket } from "../config/paths.js";
import { AxiError } from "../errors.js";
import { EMPTY_HOME_HINTS, HOME_HINTS } from "../guidance.js";
import { DESCRIPTION } from "../meta.js";
import { collapseHome, countNoun, joinBlocks, renderDetail, renderHelp, renderRows } from "../output/render.js";
import { newerSchema } from "../store/readonly-db.js";
import { resolveNote } from "../store/refs.js";
import { listColumns } from "./note-columns.js";

export const DEFAULT_RECENT_LIMIT = 5;
export const DEFAULT_PINNED_LIMIT = 9;

const ROW_COLUMNS = listColumns(["id", "title", "updated"], new Map());

/** What home reports about the helper: the probe, plus `refused` for a runtime dir or socket that fails the trust check. */
export type HelperView = HelperProbe | { state: "refused" };

export function helperLine(view: HelperView): string {
  switch (view.state) {
    case "running":
      return `running v${view.version}`;
    case "not-answering":
      return "not answering (overnote-axi status)";
    case "stopped":
      return "stopped (reads work; writes need overnote-axi open)";
    case "refused":
      return "refused (its runtime dir or socket is not private to you; overnote-axi status says why)";
  }
}

/**
 * A stopped probe is `refused` when the runtime dir or socket exists but fails the trust check,
 * the case where the writer hints `overnote-axi status`, because `overnote-axi open` cannot fix it.
 * Mirrors connectRefusal in src/helper/notes-writer.ts.
 */
export function helperView(probe: HelperProbe, paths: OvernotePaths, uid: number): HelperView {
  if (probe.state !== "stopped" || !exists(paths.runtimeDir)) return probe;
  if (!isTrustedRuntimeDir(paths.runtimeDir, uid)) return { state: "refused" };
  return exists(paths.socket) && !isTrustedSocket(paths.socket, uid) ? { state: "refused" } : probe;
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The first hint for a helper that cannot take writes right now. */
function helperHint(view: HelperView): string[] {
  switch (view.state) {
    case "running":
      return [];
    case "stopped":
      return ["overnote-axi open"];
    case "refused":
    case "not-answering":
      return ["overnote-axi status"];
  }
}

interface HomeData {
  counts: NoteCounts;
  current: Note | null;
  /** True when `current` is the newest live note because no live note is open in Overnote. */
  currentIsFallback: boolean;
  pinned: NoteSummary[];
  recent: NoteSummary[];
  /** The database schema (`schema` shows only when it is newer than this build was tested with). */
  schema: number;
}

function readHome(reader: NotesReader, recentLimit: number, pinnedLimit: number): HomeData {
  return reader.snapshot((snap) => {
    const counts = snap.counts();
    const schema = snap.schemaVersion();
    if (counts.live === 0) return { counts, current: null, currentIsFallback: false, pinned: [], recent: [], schema };
    const current = resolveNote(snap, "current", { allowTrashed: false });
    const currentIsFallback = current.id !== snap.currentNoteId();
    const pinned = pinnedLimit > 0 ? snap.list({ limit: pinnedLimit, pinnedOnly: true }).items : [];
    // Pinned notes sort first, so skipping them leaves the unpinned notes, newest first.
    const recent = recentLimit > 0 ? snap.list({ limit: recentLimit, offset: counts.pinned }).items : [];
    return { counts, current, currentIsFallback, pinned, recent, schema };
  });
}

/** The lines every variant starts with: where the CLI lives and what it does. */
function header(context: Context): string {
  return renderDetail({ bin: collapseHome(context.binPath, context.home), description: DESCRIPTION });
}

/** A database that exists but cannot be read (for example one without a required column): reported, never fatal. */
function readProblem(context: Context, error: AxiError): string {
  return joinBlocks([
    header(context),
    renderDetail({ overnote: { error: error.message, code: error.code, ...error.details } }),
    renderHelp(error.suggestions),
  ]);
}

export const command: CommandSpec = {
  name: "home",
  positionals: [],
  flags: [
    {
      name: "limit",
      type: "number",
      value: "<n>",
      min: 0,
      max: 50,
      default: String(DEFAULT_RECENT_LIMIT),
      description: "Recent notes to show",
    },
    {
      name: "pinned-limit",
      type: "number",
      value: "<n>",
      min: 0,
      max: 9,
      default: String(DEFAULT_PINNED_LIMIT),
      description: "Pinned notes to show (the session hook passes 3)",
    },
  ],
  examples: ["overnote-axi", "overnote-axi home --limit 3 --pinned-limit 3"],
  run: async (args, context) => {
    const recentLimit = flagNumber(args, "limit") ?? DEFAULT_RECENT_LIMIT;
    const pinnedLimit = flagNumber(args, "pinned-limit") ?? DEFAULT_PINNED_LIMIT;
    // Started first: the probe waits on the socket while the database reads run.
    const probe = context.probeHelper();

    let data: HomeData | null;
    try {
      const reader = context.tryReader();
      data = reader ? readHome(reader, recentLimit, pinnedLimit) : null;
    } catch (error) {
      await probe;
      if (error instanceof AxiError) return ok(readProblem(context, error));
      throw error;
    }
    const view = helperView(await probe, context.paths(), context.uid);
    const helper = helperLine(view);

    if (!data) {
      return ok(
        joinBlocks([header(context), renderDetail({ overnote: "no notes database yet" }), renderHelp(["overnote-axi open"])]),
      );
    }

    const { counts, current, currentIsFallback, pinned, recent, schema } = data;
    // A helper that cannot take writes leads the hints, so the next write does not fail first.
    const hints = [...helperHint(view)];
    for (const hint of counts.live === 0 ? EMPTY_HOME_HINTS : HOME_HINTS) if (!hints.includes(hint)) hints.push(hint);
    if (pinned.length < counts.pinned) hints.push(`overnote-axi list --pinned (all ${counts.pinned} ${countNoun(counts.pinned, "pinned notes")})`);
    if (recent.length < counts.live - counts.pinned) hints.push(`overnote-axi list (all ${counts.live} ${countNoun(counts.live, "live notes")})`);

    return ok(
      joinBlocks([
        header(context),
        renderDetail({
          overnote: {
            helper,
            notes: `${counts.live} live`,
            pinned: counts.pinned,
            trash: counts.trashed,
            // One line, so the session hook stays in budget; status prints the update command.
            schema: newerSchema(schema) ? `${schema}, newer than this overnote-axi was tested with (overnote-axi status)` : undefined,
          },
          current: current
            ? `${current.id} ${displayTitle(current)}${currentIsFallback ? " (newest; none open)" : ""}`
            : undefined,
        }),
        pinned.length > 0 ? renderRows("pinned", pinned, ROW_COLUMNS) : "",
        recent.length > 0 ? renderRows("recent", recent, ROW_COLUMNS) : "",
        renderHelp(hints),
      ]),
    );
  },
};
