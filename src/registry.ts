/**
 * The command registry: the single list of commands, their one-line summaries, and a lazy loader
 * for each module. Only the selected command's module (and what it imports) is ever loaded.
 *
 * test/unit/registry.test.ts checks that each module exports a spec with the same name.
 */
import type { CommandSpec } from "./command.js";

export type CommandGroup = "read" | "write" | "organize" | "setup";

export interface CommandEntry {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly load: () => Promise<{ command: CommandSpec }>;
}

export const COMMANDS: readonly CommandEntry[] = [
  // Read path: read-only SQLite, works while Overnote is closed.
  {
    name: "home",
    group: "read",
    summary: "Dashboard: helper state, counts, pinned and recent notes (the default)",
    load: () => import("./commands/home.js"),
  },
  {
    name: "list",
    group: "read",
    summary: "List live notes, pinned first, or only pinned ones",
    load: () => import("./commands/list.js"),
  },
  {
    name: "search",
    group: "read",
    summary: "Find notes whose title or text contains a query",
    load: () => import("./commands/search.js"),
  },
  {
    name: "read",
    group: "read",
    summary: "Show one or more notes as markdown",
    load: () => import("./commands/read.js"),
  },
  {
    name: "links",
    group: "read",
    summary: "Show the notes a note links to and the notes linking back",
    load: () => import("./commands/links.js"),
  },
  {
    name: "status",
    group: "read",
    summary: "Helper, database and path diagnostics",
    load: () => import("./commands/status.js"),
  },
  // Content writes: through the running Overnote helper.
  {
    name: "create",
    group: "write",
    summary: "Create a note from markdown",
    load: () => import("./commands/create.js"),
  },
  {
    name: "update",
    group: "write",
    summary: "Append (default), prepend below the title, add on top, or replace a note's markdown",
    load: () => import("./commands/update.js"),
  },
  {
    name: "edit",
    group: "write",
    summary: "Replace exact text inside a note",
    load: () => import("./commands/edit.js"),
  },
  {
    name: "link",
    group: "write",
    summary: "Print a note's markdown link, or insert it into another note",
    load: () => import("./commands/link.js"),
  },
  // Organize: pins, copies, trash. Also through the helper.
  {
    name: "pin",
    group: "organize",
    summary: "Pin a note to the end of the pinned list",
    load: () => import("./commands/pin.js"),
  },
  {
    name: "unpin",
    group: "organize",
    summary: "Unpin a note",
    load: () => import("./commands/unpin.js"),
  },
  {
    name: "move",
    group: "organize",
    summary: "Move a pinned note up or down the pinned list",
    load: () => import("./commands/move.js"),
  },
  {
    name: "duplicate",
    group: "organize",
    summary: "Copy a note into a new note",
    load: () => import("./commands/duplicate.js"),
  },
  {
    name: "delete",
    group: "organize",
    summary: "Move a note to Recently Deleted (--permanent erases it)",
    load: () => import("./commands/delete.js"),
  },
  {
    name: "recover",
    group: "organize",
    summary: "Restore a note from Recently Deleted",
    load: () => import("./commands/recover.js"),
  },
  {
    name: "trash",
    group: "organize",
    summary: "List Recently Deleted, or empty it with --empty --permanent",
    load: () => import("./commands/trash.js"),
  },
  {
    name: "open",
    group: "organize",
    summary: "Show a note (or the last one) in the Overnote panel",
    load: () => import("./commands/open.js"),
  },
  // Integrations.
  {
    name: "setup",
    group: "setup",
    summary: "Install or remove the session hook (default) or the agent skill",
    load: () => import("./commands/setup.js"),
  },
];

export function findCommand(name: string): CommandEntry | undefined {
  return COMMANDS.find((entry) => entry.name === name);
}
