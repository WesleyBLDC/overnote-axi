/**
 * `status`. Helper, database, schema and path diagnostics, plus `build`
 * (VERSION and CORE_REVISION from src/build-info.ts, the Overnote commit core was bundled from).
 *
 * A diagnostic, so it reports every problem it finds instead of failing on the first one: a
 * stopped helper, a missing or unreadable database, and an untrusted runtime dir each show up as
 * a field plus the hint that fixes it, and the command exits 0. The helper is asked once, over
 * the writer's one connection, with `system.status` (version, pid, backups).
 */
import { existsSync } from "node:fs";

import { CORE_REVISION } from "../build-info.js";
import { ok, type CommandSpec } from "../command.js";
import { isTrustedRuntimeDir, isTrustedSocket } from "../config/paths.js";
import type { Context } from "../context.js";
import type { NoteCounts, OvernotePaths, SystemStatus } from "../domain/types.js";
import { AxiError } from "../errors.js";
import { collapseHome, isoDate, joinBlocks, renderDetail, renderHelp } from "../output/render.js";
import { VERSION } from "../version.js";

type HelperReport =
  | { state: "running"; status: SystemStatus }
  | { state: "stopped"; reason: string }
  | { state: "not answering" }
  | { state: "error"; error: AxiError };

type DatabaseReport =
  | { state: "ok"; schema: number; counts: NoteCounts }
  | { state: "missing" }
  | { state: "unreadable"; error: AxiError };

/** Why no trusted socket could be reached, checked in the order the writer checks. */
export function stoppedReason(paths: OvernotePaths, uid: number): string {
  if (!existsSync(paths.runtimeDir)) return "no runtime dir (Overnote is not running)";
  if (!isTrustedRuntimeDir(paths.runtimeDir, uid)) return "runtime dir refused (not a private directory owned by you)";
  if (!existsSync(paths.socket)) return "no socket (Overnote is not running)";
  if (!isTrustedSocket(paths.socket, uid)) return "socket refused (not a socket owned by you)";
  return "socket refused the connection";
}

async function askHelper(context: Context): Promise<HelperReport> {
  try {
    const writer = await context.writer();
    return { state: "running", status: await writer.status() };
  } catch (error) {
    if (!(error instanceof AxiError)) throw error;
    if (error.code === "HELPER_NOT_RUNNING") return { state: "stopped", reason: stoppedReason(context.paths(), context.uid) };
    if (error.code === "HELPER_TIMEOUT") return { state: "not answering" };
    return { state: "error", error };
  }
}

function readDatabase(context: Context): DatabaseReport {
  try {
    const reader = context.tryReader();
    if (!reader) return { state: "missing" };
    return reader.snapshot((snap) => ({ state: "ok", schema: snap.schemaVersion(), counts: snap.counts() }));
  } catch (error) {
    if (error instanceof AxiError) return { state: "unreadable", error };
    throw error;
  }
}

function helperSection(report: HelperReport): Record<string, unknown> {
  switch (report.state) {
    case "running":
      return { state: "running", version: report.status.version, pid: report.status.pid };
    case "stopped":
      return { state: "stopped", reason: report.reason };
    case "not answering":
      return { state: "not answering" };
    case "error":
      return { state: "error", error: report.error.message, code: report.error.code };
  }
}

function databaseSection(report: DatabaseReport, file: string): Record<string, unknown> {
  switch (report.state) {
    case "ok":
      return { path: file, schema: report.schema, notes: `${report.counts.live} live`, trash: report.counts.trashed };
    case "missing":
      return { path: file, state: "missing" };
    case "unreadable":
      return { path: file, state: "unreadable", error: report.error.message, code: report.error.code, ...report.error.details };
  }
}

function backupsSection(status: SystemStatus): Record<string, unknown> {
  return {
    count: status.backupCount,
    latest: status.latestBackup ? isoDate(status.latestBackup.createdAt) : "none",
    // Only worth a line when the helper is offering to restore a backup.
    restore: status.restoreAvailable ? "available (the helper started without a database; restore it in Overnote)" : undefined,
  };
}

function hintsFor(helper: HelperReport, database: DatabaseReport): string[] {
  const hints = new Set<string>();
  if (helper.state !== "running") hints.add("overnote-axi open");
  if (helper.state === "error") for (const line of helper.error.suggestions) hints.add(line);
  if (database.state === "missing") {
    hints.add("overnote-axi open");
    hints.add("Or point OVERNOTE_SUPPORT_DIR at the folder that holds notes.sqlite");
  }
  if (database.state === "unreadable") for (const line of database.error.suggestions) hints.add(line);
  // This command is the place those hints would send the agent; do not send it here again.
  hints.delete("overnote-axi status");
  return [...hints];
}

export const command: CommandSpec = {
  name: "status",
  positionals: [],
  flags: [],
  notes: ["Always exits 0: problems are reported as fields with the hint that fixes them"],
  examples: ["overnote-axi status"],
  run: async (_args, context) => {
    const paths = context.paths();
    const database = readDatabase(context);
    const helper = await askHelper(context);
    return ok(
      joinBlocks([
        renderDetail({
          helper: helperSection(helper),
          database: databaseSection(database, collapseHome(paths.database, context.home)),
          socket: collapseHome(paths.socket, context.home),
          backups: helper.state === "running" ? backupsSection(helper.status) : undefined,
          build: { version: VERSION, core: CORE_REVISION },
        }),
        renderHelp(hintsFor(helper, database)),
      ]),
    );
  },
};
