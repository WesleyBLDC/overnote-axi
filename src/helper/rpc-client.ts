/**
 * Newline-delimited JSON-RPC over the helper's Unix socket.
 *
 * Port of overnote src/domain/rpc-client.ts (architecture.md section 2): one connection, ids
 * matched out of order, 3 s default timeout, 1 s connect timeout, the socket unref'd while idle
 * so it never keeps the process alive. Typed by @overnote/core's rpc.Methods.
 */
import net from "node:net";

import type { rpc } from "@overnote/core/text";

export type SocketMethods = Omit<rpc.Methods, rpc.BridgeOnlyMethod>;
export type SocketMethod = keyof SocketMethods;
export type MethodParams<M extends SocketMethod> = SocketMethods[M]["params"];
export type MethodResult<M extends SocketMethod> = SocketMethods[M]["result"];

export const DEFAULT_TIMEOUT_MS = 3000;
export const CONNECT_TIMEOUT_MS = 1000;
/** Connect plus ping budget for the home view and the session hook (a hung socket must not stall a session). */
export const PROBE_TIMEOUT_MS = 400;

/** The helper answered with an error object (`code` is the protocol code, for example 404). */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`helper did not answer ${method}`);
    this.name = "RpcTimeoutError";
  }
}

/**
 * The socket is missing, refused, or closed mid call. `stage` says which: `connect` means
 * nothing was sent, so the caller knows no write can have landed.
 */
export class RpcConnectionError extends Error {
  constructor(
    message: string,
    readonly stage: "connect" | "connect-timeout" | "closed" = "connect",
  ) {
    super(message);
    this.name = "RpcConnectionError";
  }
}

export interface RpcTransport {
  call<M extends SocketMethod>(method: M, params: MethodParams<M>, timeoutMs?: number): Promise<MethodResult<M>>;
  close(): void;
}

export interface RpcClientOptions {
  /** Budget for one connect attempt. */
  connectTimeoutMs?: number;
  /**
   * Runs before every connect attempt, including a silent reconnect after the helper dropped the
   * connection. Returning false fails the attempt with RpcConnectionError (stage `connect`), so
   * nothing is sent to a socket that no longer passes the trust checks.
   */
  beforeConnect?: () => boolean;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResponseLine {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

export class RpcClient implements RpcTransport {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;

  readonly connectTimeoutMs: number;
  private readonly beforeConnect: () => boolean;

  constructor(
    readonly socketPath: string,
    options: RpcClientOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.beforeConnect = options.beforeConnect ?? (() => true);
  }

  /** Connects now (or reuses the open connection) without sending anything. */
  async ready(): Promise<void> {
    await this.connect();
  }

  async call<M extends SocketMethod>(
    method: M,
    params: MethodParams<M>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<MethodResult<M>> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.updateRef();
        reject(new RpcTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (value) => resolve(value as MethodResult<M>), reject, timer });
      this.updateRef();
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.settle(id, { error: new RpcConnectionError(`could not send ${method}`, "closed") });
      });
    });
  }

  /** Closes the connection and rejects anything still in flight. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    socket?.destroy();
    this.failAll(new RpcConnectionError("connection closed", "closed"));
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    if (!this.beforeConnect()) {
      return Promise.reject(new RpcConnectionError("the helper socket failed the trust checks", "connect"));
    }

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        this.connecting = null;
        reject(new RpcConnectionError("timed out connecting to the helper", "connect-timeout"));
      }, this.connectTimeoutMs);

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connecting = null;
        socket.on("error", () => undefined);
        socket.on("close", () => this.onClose(socket));
        socket.on("data", (chunk: string) => this.onData(chunk));
        this.updateRef();
        resolve(socket);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        this.connecting = null;
        reject(new RpcConnectionError("could not connect to the helper", "connect"));
      });
    });
    return this.connecting;
  }

  private onClose(socket: net.Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = "";
    this.failAll(new RpcConnectionError("the helper closed the connection", "closed"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: ResponseLine;
    try {
      message = JSON.parse(line) as ResponseLine;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : 500;
      const text = typeof message.error.message === "string" ? message.error.message : "unknown helper error";
      this.settle(message.id, { error: new RpcError(code, text, entry.method) });
    } else {
      this.settle(message.id, { value: message.result ?? null });
    }
  }

  private settle(id: number, outcome: { value: unknown } | { error: Error }): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.updateRef();
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.value);
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { error });
  }

  private updateRef(): void {
    if (!this.socket) return;
    if (this.pending.size > 0) this.socket.ref();
    else this.socket.unref();
  }
}
