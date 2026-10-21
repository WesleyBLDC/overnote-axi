/**
 * Newline-delimited JSON-RPC over the helper's Unix socket (slice: foundation).
 *
 * Port of overnote src/domain/rpc-client.ts (architecture.md section 2): one connection, ids
 * matched out of order, 3 s default timeout, 1 s connect timeout, the socket unref'd while idle
 * so it never keeps the process alive. Typed by @overnote/core's rpc.Methods.
 */
import type { rpc } from "@overnote/core/text";

import { notImplemented } from "../errors.js";

export type SocketMethods = Omit<rpc.Methods, rpc.BridgeOnlyMethod>;
export type SocketMethod = keyof SocketMethods;
export type MethodParams<M extends SocketMethod> = SocketMethods[M]["params"];
export type MethodResult<M extends SocketMethod> = SocketMethods[M]["result"];

export const DEFAULT_TIMEOUT_MS = 3000;
export const CONNECT_TIMEOUT_MS = 1000;

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

/** The socket is missing, refused, or closed mid call. */
export class RpcConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcConnectionError";
  }
}

export interface RpcTransport {
  call<M extends SocketMethod>(method: M, params: MethodParams<M>, timeoutMs?: number): Promise<MethodResult<M>>;
  close(): void;
}

export class RpcClient implements RpcTransport {
  constructor(readonly socketPath: string) {}

  call<M extends SocketMethod>(_method: M, _params: MethodParams<M>, _timeoutMs?: number): Promise<MethodResult<M>> {
    throw notImplemented("RpcClient.call");
  }

  close(): void {}
}
