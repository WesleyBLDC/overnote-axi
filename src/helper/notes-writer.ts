/**
 * NotesWriter over the helper socket (slice: foundation).
 *
 * Maps each method to its `notes.*` / `system.*` RPC and translates failures into AxiErrors:
 * connection refused or missing socket to HELPER_NOT_RUNNING (hint: `overnote-axi open`),
 * timeouts to HELPER_TIMEOUT, 404 to NOTE_NOT_FOUND, 409 to NOT_PINNED or NOTE_TRASHED by
 * method, anything else to HELPER_ERROR. Never leaks the socket path errno or helper text.
 * The writer translates uniformly; commands decide what a code means for them (for example
 * `delete --permanent` catches NOTE_NOT_FOUND from permanentlyDelete and reports `(no-op)`).
 *
 * Before connecting, the runtime dir must pass isTrustedRuntimeDir and the socket must pass
 * isTrustedSocket (src/config/paths.ts); otherwise HELPER_NOT_RUNNING.
 */
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
import { notImplemented } from "../errors.js";
import type { RpcTransport } from "./rpc-client.js";

/**
 * Connects and pings once (so HELPER_NOT_RUNNING surfaces before any work), refusing a runtime
 * dir that is not owned by the current user.
 */
export async function connectWriter(_socketPath: string, _runtimeDir: string, _uid: number): Promise<NotesWriter> {
  throw notImplemented("connectWriter");
}

/**
 * One connect plus `system.ping` within `timeoutMs` total (PROBE_TIMEOUT_MS for home and hooks).
 * Never throws: a missing or untrusted socket is `stopped`, a silent one is `not-answering`.
 */
export async function probeHelper(
  _socketPath: string,
  _runtimeDir: string,
  _uid: number,
  _timeoutMs: number,
): Promise<HelperProbe> {
  throw notImplemented("probeHelper");
}

export class HelperNotesWriter implements NotesWriter {
  constructor(readonly transport: RpcTransport) {}

  ping(): Promise<{ version: string; pid: number }> {
    throw notImplemented("ping");
  }
  status(): Promise<SystemStatus> {
    throw notImplemented("status");
  }
  create(_content: NoteContent, _options?: { show?: boolean }): Promise<Note> {
    throw notImplemented("create");
  }
  get(_id: NoteId): Promise<Note> {
    throw notImplemented("get");
  }
  update(_params: UpdateParams): Promise<UpdateResult> {
    throw notImplemented("update");
  }
  trash(_id: NoteId): Promise<void> {
    throw notImplemented("trash");
  }
  recover(_id: NoteId): Promise<Note> {
    throw notImplemented("recover");
  }
  permanentlyDelete(_id: NoteId): Promise<void> {
    throw notImplemented("permanentlyDelete");
  }
  emptyTrash(): Promise<number> {
    throw notImplemented("emptyTrash");
  }
  duplicate(_id: NoteId, _titleSuffix?: string): Promise<Note> {
    throw notImplemented("duplicate");
  }
  pin(_id: NoteId): Promise<Note> {
    throw notImplemented("pin");
  }
  unpin(_id: NoteId): Promise<Note> {
    throw notImplemented("unpin");
  }
  movePinned(_id: NoteId, _direction: PinDirection): Promise<void> {
    throw notImplemented("movePinned");
  }
  close(): void {
    this.transport.close();
  }
}
