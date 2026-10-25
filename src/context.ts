/**
 * Everything a command may touch, behind lazy getters so each command pays only for what it uses
 * (opening SQLite, connecting to the helper, loading the core chunk). Tests build a Context with
 * fakes through `createContext({ ...overrides })`.
 */
import os from "node:os";

import type { HelperProbe, MarkdownConverter, NotesReader, NotesWriter, OvernotePaths } from "./domain/types.js";
import { resolvePaths as resolveDefaultPaths } from "./config/paths.js";
import { axiError } from "./errors.js";
import { NAME } from "./meta.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Output {
  write(chunk: string): unknown;
}

export interface Context {
  readonly env: Env;
  readonly home: string;
  readonly uid: number;
  readonly cwd: string;
  /** Absolute path of the running executable (for the home view and hook commands). */
  readonly binPath: string;
  now(): number;
  paths(): OvernotePaths;
  /** Opens the database read-only on first use; DATABASE_NOT_FOUND when it does not exist. */
  reader(): NotesReader;
  /** Like reader(), but null instead of DATABASE_NOT_FOUND (for the home view and hooks). */
  tryReader(): NotesReader | null;
  /** Connects to the running helper on first use; HELPER_NOT_RUNNING when it is not answering. */
  writer(): Promise<NotesWriter>;
  /**
   * Pings the helper with a short timeout (PROBE_TIMEOUT_MS) and never throws: the home view and
   * the session hook use it so a hung socket cannot stall a session start.
   */
  probeHelper(): Promise<HelperProbe>;
  /** Waits, for the post write verify window; tests inject an instant one. */
  sleep(ms: number): Promise<void>;
  /** Loads the @overnote/core chunk on first use. */
  converter(): Promise<MarkdownConverter>;
  /** All of stdin when it is piped, null when stdin is a terminal. */
  readStdin(): Promise<string | null>;
  /** Opens a URL with macOS `open` (no shell). */
  openUrl(url: string): Promise<void>;
  /** Closes the database and the socket. The CLI calls it after every command. */
  close(): void;
}

export interface ContextOverrides {
  env?: Env;
  home?: string;
  uid?: number;
  cwd?: string;
  binPath?: string;
  now?: () => number;
  paths?: () => OvernotePaths;
  openReader?: (file: string, binPath: string, home: string) => NotesReader | null;
  connectWriter?: (paths: OvernotePaths, uid: number) => Promise<NotesWriter>;
  probeHelper?: (paths: OvernotePaths, uid: number) => Promise<HelperProbe>;
  sleep?: (ms: number) => Promise<void>;
  loadConverter?: () => Promise<MarkdownConverter>;
  readStdin?: () => Promise<string | null>;
  openUrl?: (url: string) => Promise<void>;
}

export function createContext(overrides: ContextOverrides = {}): Context {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? env.HOME ?? os.homedir();
  const uid = overrides.uid ?? os.userInfo().uid;

  let paths: OvernotePaths | undefined;
  let reader: NotesReader | null | undefined;
  let writer: Promise<NotesWriter> | undefined;
  let converter: Promise<MarkdownConverter> | undefined;

  // Resolved synchronously on first use; the module is tiny and has no dependencies.
  const resolvePaths = overrides.paths ?? (() => resolveDefaultPaths({ env, home, uid }));

  const context: Context = {
    env,
    home,
    uid,
    cwd: overrides.cwd ?? process.cwd(),
    binPath: overrides.binPath ?? process.argv[1] ?? NAME,
    now: overrides.now ?? (() => Date.now()),
    paths() {
      paths ??= resolvePaths();
      return paths;
    },
    tryReader() {
      if (reader === undefined) {
        const open = overrides.openReader;
        if (!open) throw axiError("internal: no reader factory configured", "UNKNOWN");
        reader = open(context.paths().database, context.binPath, home);
      }
      return reader;
    },
    reader() {
      const found = context.tryReader();
      if (found) return found;
      throw axiError("no Overnote database found", "DATABASE_NOT_FOUND", [
        "Open Overnote once so it creates its database: overnote-axi open",
        "Or point OVERNOTE_SUPPORT_DIR at the folder that holds notes.sqlite",
      ]);
    },
    writer() {
      if (!writer) {
        const connect = overrides.connectWriter;
        if (!connect) return Promise.reject(axiError("internal: no writer factory configured", "UNKNOWN"));
        writer = connect(context.paths(), uid);
        // A failed connection is not cached, so a later call can retry.
        writer.catch(() => {
          writer = undefined;
        });
      }
      return writer;
    },
    probeHelper() {
      const probe = overrides.probeHelper;
      if (!probe) return Promise.resolve({ state: "stopped" });
      return probe(context.paths(), uid).catch(() => ({ state: "stopped" }) as const);
    },
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    converter() {
      if (!converter) {
        const load = overrides.loadConverter;
        if (!load) return Promise.reject(axiError("internal: no converter configured", "UNKNOWN"));
        converter = load();
      }
      return converter;
    },
    readStdin: overrides.readStdin ?? (() => Promise.resolve(null)),
    openUrl: overrides.openUrl ?? (() => Promise.reject(axiError("internal: no URL opener configured", "UNKNOWN"))),
    close() {
      reader?.close();
      reader = undefined;
      const pending = writer;
      writer = undefined;
      void pending?.then((client) => client.close()).catch(() => undefined);
    },
  };
  return context;
}
