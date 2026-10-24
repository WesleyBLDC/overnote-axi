/**
 * NotesWriter over the helper socket.
 *
 * Maps each method to its `notes.*` / `system.*` RPC and translates failures into AxiErrors:
 * connection refused or missing socket to HELPER_NOT_RUNNING (hint: `overnote-axi open`),
 * timeouts to HELPER_TIMEOUT, 404 to NOTE_NOT_FOUND, 409 to NOT_PINNED or NOTE_TRASHED by
 * method, anything else to HELPER_ERROR. Never leaks the socket path errno or helper text.
 * A timeout of `notes.create` or `notes.duplicate` says the note may have landed and hints
 * `list --sort created` first, since retrying either one blindly makes a second note.
 * The writer translates uniformly; commands decide what a code means for them (for example
 * `delete --permanent` catches NOTE_NOT_FOUND from permanentlyDelete and reports `(no-op)`).
 *
 * Before every connection (the first one and any silent reconnect), the runtime dir must pass
 * isTrustedRuntimeDir and the socket must pass isTrustedSocket (src/config/paths.ts); otherwise
 * HELPER_NOT_RUNNING. The checks run through RpcClient's beforeConnect guard.
 *
 * A connection that drops after a write was sent maps to OUTCOME_UNKNOWN: the write may have
 * landed, so its first hint is to look before retrying, and an agent does not blindly repeat an
 * append or a create. A drop during a read (`system.*`, `notes.get`) changed nothing and stays
 * HELPER_NOT_RUNNING.
 */
import { lstatSync } from "node:fs";

import { isTrustedRuntimeDir, isTrustedSocket } from "../config/paths.js";
import type {
  HelperProbe,
  Note,
  NoteContent,
  NoteId,
  NotesWriter,
  PinDirection,
  SystemStatus,
  UpdateParams,
  UpdateResult,
} from "../domain/types.js";
import { AxiError, axiError } from "../errors.js";
import {
  RpcClient,
  RpcConnectionError,
  RpcError,
  RpcTimeoutError,
  type MethodParams,
  type MethodResult,
  type RpcTransport,
  type SocketMethod,
} from "./rpc-client.js";

const NOT_FOUND = 404;
const CONFLICT = 409;

function helperNotRunning(message = "Overnote is not running"): AxiError {
  return axiError(`${message}; reads still work, writes need it`, "HELPER_NOT_RUNNING", ["overnote-axi open"]);
}

/**
 * The runtime dir or socket exists but fails the trust check. Opening Overnote would not fix
 * that, so the hint is `status`, which names what was refused.
 */
function helperUntrusted(): AxiError {
  return axiError(
    "refused the Overnote helper socket because its runtime dir or socket is not private to you; reads still work, writes need it",
    "HELPER_NOT_RUNNING",
    ["overnote-axi status"],
  );
}

/** Why a connection may not be attempted: nothing there yet, or something there that is not trusted. */
function connectRefusal(socketPath: string, runtimeDir: string, uid: number): AxiError | null {
  if (trusted(socketPath, runtimeDir, uid)) return null;
  const present = lstatExists(runtimeDir) && (!isTrustedRuntimeDir(runtimeDir, uid) || lstatExists(socketPath));
  return present ? helperUntrusted() : helperNotRunning();
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** A 409 from the helper, by method: the codes a caller can act on. */
function conflictError(method: string, helperMessage: string): AxiError {
  // The helper says "Recently Deleted" when a live note was required (pin, move); that is the more precise code.
  if (/recently deleted/i.test(helperMessage) || method === "notes.pin") {
    return axiError("the note is in Recently Deleted", "NOTE_TRASHED", ["overnote-axi recover <id>"]);
  }
  if (method === "notes.movePinnedUp" || method === "notes.movePinnedDown") {
    return axiError("the note is not pinned", "NOT_PINNED", ["overnote-axi pin <id>"]);
  }
  return axiError(`Overnote refused ${method}`, "HELPER_ERROR", ["overnote-axi status"]);
}

/** Calls that change nothing, so a dropped connection during one cannot leave a half known write. */
const READ_METHODS: ReadonlySet<string> = new Set(["system.ping", "system.status", "notes.get"]);

/** Calls that make a new note: a retry after an unknown outcome makes a second one. */
const CREATING_METHODS: ReadonlySet<string> = new Set(["notes.create", "notes.duplicate"]);

/** Where to look before retrying a write whose outcome is unknown. */
function lookFirst(method: string | undefined): string {
  return method !== undefined && CREATING_METHODS.has(method) ? "overnote-axi list --sort created" : "overnote-axi read <id>";
}

/**
 * Turns any failure of a helper call into an AxiError. Raw helper text, errno values and the
 * socket path never reach the message. `method` is the call that failed, when known.
 */
export function translateHelperError(error: unknown, method?: string): AxiError {
  if (error instanceof AxiError) return error;
  if (error instanceof RpcConnectionError) {
    if (error.stage !== "closed") return helperNotRunning();
    if (method !== undefined && READ_METHODS.has(method)) return helperNotRunning("Overnote closed the connection");
    return axiError(
      `the Overnote helper closed the connection during ${method ?? "a call"}, so the write may or may not have landed; check before retrying`,
      "OUTCOME_UNKNOWN",
      [lookFirst(method), "overnote-axi status"],
    );
  }
  if (error instanceof RpcTimeoutError) {
    if (CREATING_METHODS.has(error.method)) {
      return axiError(
        `Overnote did not answer ${error.method} in time; the note may have landed, so check before retrying`,
        "HELPER_TIMEOUT",
        [lookFirst(error.method), "overnote-axi status"],
      );
    }
    return axiError(`Overnote did not answer ${error.method} in time; retry once`, "HELPER_TIMEOUT", [
      "overnote-axi status",
    ]);
  }
  if (error instanceof RpcError) {
    if (error.code === NOT_FOUND) {
      return axiError("no note matches that id", "NOTE_NOT_FOUND", ['overnote-axi search "<text>"']);
    }
    if (error.code === CONFLICT) return conflictError(error.method, error.message);
    return axiError(`Overnote could not complete ${error.method}`, "HELPER_ERROR", ["overnote-axi status"], {
      helperCode: error.code,
    });
  }
  return axiError("unexpected failure talking to Overnote", "HELPER_ERROR", ["overnote-axi status"]);
}

function trusted(socketPath: string, runtimeDir: string, uid: number): boolean {
  return isTrustedRuntimeDir(runtimeDir, uid) && isTrustedSocket(socketPath, uid);
}

function guardedClient(socketPath: string, runtimeDir: string, uid: number, connectTimeoutMs?: number): RpcClient {
  return new RpcClient(socketPath, {
    beforeConnect: () => trusted(socketPath, runtimeDir, uid),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
  });
}

/**
 * Connects and pings once (so HELPER_NOT_RUNNING surfaces before any work), refusing a runtime
 * dir that is not owned by the current user.
 */
export async function connectWriter(socketPath: string, runtimeDir: string, uid: number): Promise<NotesWriter> {
  const refusal = connectRefusal(socketPath, runtimeDir, uid);
  if (refusal) throw refusal;
  const writer = new HelperNotesWriter(guardedClient(socketPath, runtimeDir, uid));
  try {
    await writer.ping();
  } catch (error) {
    writer.close();
    throw error;
  }
  return writer;
}

/**
 * One connect plus `system.ping` within `timeoutMs` total (PROBE_TIMEOUT_MS for home and hooks).
 * Never throws: a missing or untrusted socket is `stopped`, a silent one is `not-answering`.
 */
export async function probeHelper(
  socketPath: string,
  runtimeDir: string,
  uid: number,
  timeoutMs: number,
): Promise<HelperProbe> {
  if (!trusted(socketPath, runtimeDir, uid)) return { state: "stopped" };
  // One deadline for the whole probe: connecting spends part of it, the ping gets what is left.
  const deadline = Date.now() + timeoutMs;
  const client = guardedClient(socketPath, runtimeDir, uid, timeoutMs);
  try {
    await client.ready();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: "not-answering" };
    const pong = await client.call("system.ping", {}, remaining);
    return { state: "running", version: String(pong.version), pid: Number(pong.pid) };
  } catch (error) {
    if (error instanceof RpcTimeoutError) return { state: "not-answering" };
    if (error instanceof RpcConnectionError && error.stage === "connect-timeout") return { state: "not-answering" };
    return { state: "stopped" };
  } finally {
    client.close();
  }
}

export class HelperNotesWriter implements NotesWriter {
  constructor(readonly transport: RpcTransport) {}

  private async call<M extends SocketMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    try {
      return await this.transport.call(method, params);
    } catch (error) {
      throw translateHelperError(error, method);
    }
  }

  ping(): Promise<{ version: string; pid: number }> {
    return this.call("system.ping", {});
  }
  status(): Promise<SystemStatus> {
    return this.call("system.status", {});
  }
  create(content: NoteContent, options: { show?: boolean } = {}): Promise<Note> {
    const { rawContent, markdown, text, title } = content;
    return this.call("notes.create", {
      rawContent,
      markdown,
      text,
      title,
      ...(options.show === undefined ? {} : { show: options.show }),
    });
  }
  get(id: NoteId): Promise<Note> {
    return this.call("notes.get", { id });
  }
  update(params: UpdateParams): Promise<UpdateResult> {
    return this.call("notes.update", params);
  }
  async trash(id: NoteId): Promise<void> {
    await this.call("notes.delete", { id });
  }
  recover(id: NoteId): Promise<Note> {
    return this.call("notes.recover", { id });
  }
  async permanentlyDelete(id: NoteId): Promise<void> {
    await this.call("notes.permanentlyDelete", { id });
  }
  async emptyTrash(): Promise<number> {
    const { count } = await this.call("notes.emptyTrash", {});
    return count;
  }
  duplicate(id: NoteId, content?: NoteContent): Promise<Note> {
    if (!content) return this.call("notes.duplicate", { id });
    const { rawContent, markdown, text, title } = content;
    return this.call("notes.duplicate", { id, rawContent, markdown, text, title });
  }
  pin(id: NoteId): Promise<Note> {
    return this.call("notes.pin", { id });
  }
  unpin(id: NoteId): Promise<Note> {
    return this.call("notes.unpin", { id });
  }
  async movePinned(id: NoteId, direction: PinDirection): Promise<void> {
    await this.call(direction === "up" ? "notes.movePinnedUp" : "notes.movePinnedDown", { id });
  }
  async setCurrentNote(id: NoteId): Promise<void> {
    await this.call("notes.setCurrentNote", { noteId: id });
  }
  close(): void {
    this.transport.close();
  }
}
