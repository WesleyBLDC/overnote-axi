/**
 * The RPC client, the writer's error translation, and the probe against a scripted socket server
 * in a temp runtime dir (no real helper).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AxiError } from "../../src/errors.js";
import { connectWriter, HelperNotesWriter, probeHelper, translateHelperError } from "../../src/helper/notes-writer.js";
import {
  RpcClient,
  RpcConnectionError,
  RpcError,
  RpcTimeoutError,
  type RpcTransport,
} from "../../src/helper/rpc-client.js";
import { assertIsolated } from "../fixtures/guard.js";

type Handler = (request: { id: number; method: string; params: unknown }, reply: (line: unknown) => void) => void;

const uid = os.userInfo().uid;

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("helper socket client", () => {
  let root: string;
  let runtimeDir: string;
  let socket: string;
  let server: net.Server | null;
  let received: { method: string; params: unknown }[];
  let connections: Set<net.Socket>;

  async function serve(handler: Handler): Promise<void> {
    server = net.createServer((connection) => {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string; params: unknown };
          buffer = buffer.slice(newline + 1);
          received.push({ method: request.method, params: request.params });
          handler(request, (line) => connection.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`));
          newline = buffer.indexOf("\n");
        }
      });
      connection.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
  }

  beforeEach(() => {
    root = mkdtempSync("/tmp/onx-rpc-");
    runtimeDir = path.join(root, "run");
    socket = path.join(runtimeDir, "helper.sock");
    assertIsolated(socket);
    mkdirSync(runtimeDir, { mode: 0o700 });
    server = null;
    received = [];
    connections = new Set();
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const echo: Handler = ({ id, method, params }, reply) => {
    if (method === "system.ping") reply({ id, result: { version: "9.9.9", pid: 77 } });
    else reply({ id, result: { echoed: method, params } });
  };

  it("matches replies out of order, skipping junk lines", async () => {
    const held: (() => void)[] = [];
    await serve(({ id, method }, reply) => {
      held.push(() => reply({ id, result: { method } }));
      if (held.length === 2) {
        reply("not json");
        reply({ id: 999, result: "stray" });
        held[1]!();
        held[0]!();
      }
    });
    const client = new RpcClient(socket);
    const [a, b] = await Promise.all([client.call("notes.count", {}), client.call("notes.listDeleted", {})]);
    expect(a).toEqual({ method: "notes.count" });
    expect(b).toEqual({ method: "notes.listDeleted" });
    client.close();
  });

  it("rejects with RpcError carrying the protocol code", async () => {
    await serve(({ id }, reply) => reply({ id, error: { code: 404, message: "Note not found: X" } }));
    const client = new RpcClient(socket);
    const error = await errorOf(client.call("notes.get", { id: "X" }));
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: 404, method: "notes.get" });
    client.close();
  });

  it("times out a silent call and a missing socket fails to connect", async () => {
    await serve(() => undefined);
    const client = new RpcClient(socket);
    expect(await errorOf(client.call("system.ping", {}, 30))).toBeInstanceOf(RpcTimeoutError);
    client.close();
    const missing = new RpcClient(path.join(runtimeDir, "missing.sock"));
    expect(await errorOf(missing.call("system.ping", {}))).toMatchObject({ name: "RpcConnectionError", stage: "connect" });
  });

  it("fails in flight calls when the helper closes the connection, then reconnects", async () => {
    let first = true;
    server = net.createServer((connection) => {
      connection.on("data", (chunk) => {
        const request = JSON.parse(String(chunk).trim()) as { id: number };
        if (first) {
          first = false;
          connection.destroy();
        } else connection.write(`${JSON.stringify({ id: request.id, result: { count: 3 } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
    const client = new RpcClient(socket);
    expect(await errorOf(client.call("notes.count", {}))).toMatchObject({ stage: "closed" });
    expect(await client.call("notes.count", {})).toEqual({ count: 3 });
    client.close();
  });

  it("runs the beforeConnect guard on every connect attempt, sending nothing when it fails", async () => {
    await serve(echo);
    let allowed = false;
    const client = new RpcClient(socket, { beforeConnect: () => allowed });
    expect(await errorOf(client.call("system.ping", {}))).toMatchObject({ name: "RpcConnectionError", stage: "connect" });
    expect(received).toEqual([]);
    allowed = true;
    await client.ready();
    expect(await client.call("system.ping", {})).toEqual({ version: "9.9.9", pid: 77 });
    client.close();
  });

  it("repeats the trust checks when a writer reconnects after the helper restarts", async () => {
    await serve(echo);
    const writer = await connectWriter(socket, runtimeDir, uid);
    expect(await writer.get("A")).toEqual({ echoed: "notes.get", params: { id: "A" } });
    // Stop the helper: drop the open connection and the listener, then wait for the client to see it.
    const stopped = new Promise((resolve) => server!.close(resolve));
    for (const connection of connections) connection.destroy();
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 20));
    chmodSync(runtimeDir, 0o755);
    received = [];
    await serve(echo);
    const error = (await errorOf(writer.get("A"))) as AxiError;
    expect(error.code).toBe("HELPER_NOT_RUNNING");
    expect(error.suggestions).toEqual(["overnote-axi open"]);
    expect(received).toEqual([]);
    chmodSync(runtimeDir, 0o700);
    expect(await writer.get("B")).toEqual({ echoed: "notes.get", params: { id: "B" } });
    writer.close();
  });

  it("connectWriter pings first and maps every writer method to its RPC", async () => {
    await serve(echo);
    const writer = await connectWriter(socket, runtimeDir, uid);
    expect(received.map((r) => r.method)).toEqual(["system.ping"]);
    const content = { rawContent: "{}", markdown: "m", text: "t", title: "T" };
    await writer.create(content);
    await writer.create(content, { show: true });
    await writer.get("A");
    await writer.update({ id: "A", expectedUpdatedAt: 5, markdown: "x" });
    await writer.trash("A");
    await writer.recover("A");
    await writer.permanentlyDelete("A");
    await writer.duplicate("A");
    await writer.duplicate("A", content);
    await writer.pin("A");
    await writer.unpin("A");
    await writer.movePinned("A", "up");
    await writer.movePinned("A", "down");
    await writer.status();
    writer.close();
    expect(received.slice(1)).toEqual([
      { method: "notes.create", params: content },
      { method: "notes.create", params: { ...content, show: true } },
      { method: "notes.get", params: { id: "A" } },
      { method: "notes.update", params: { id: "A", expectedUpdatedAt: 5, markdown: "x" } },
      { method: "notes.delete", params: { id: "A" } },
      { method: "notes.recover", params: { id: "A" } },
      { method: "notes.permanentlyDelete", params: { id: "A" } },
      { method: "notes.duplicate", params: { id: "A" } },
      { method: "notes.duplicate", params: { id: "A", ...content } },
      { method: "notes.pin", params: { id: "A" } },
      { method: "notes.unpin", params: { id: "A" } },
      { method: "notes.movePinnedUp", params: { id: "A" } },
      { method: "notes.movePinnedDown", params: { id: "A" } },
      { method: "system.status", params: {} },
    ]);
  });

  it("returns the emptyTrash count", async () => {
    await serve(({ id, method }, reply) =>
      reply({ id, result: method === "system.ping" ? { version: "1", pid: 1 } : { count: 4 } }),
    );
    const writer = await connectWriter(socket, runtimeDir, uid);
    expect(await writer.emptyTrash()).toBe(4);
    writer.close();
  });

  it("refuses an untrusted runtime dir or a missing socket with HELPER_NOT_RUNNING", async () => {
    expect(await errorOf(connectWriter(socket, runtimeDir, uid))).toMatchObject({
      code: "HELPER_NOT_RUNNING",
      message: "Overnote is not running; reads still work, writes need it",
      suggestions: ["overnote-axi open"],
    });
    await serve(echo);
    chmodSync(runtimeDir, 0o755);
    const error = (await errorOf(connectWriter(socket, runtimeDir, uid))) as AxiError;
    expect(error.code).toBe("HELPER_NOT_RUNNING");
    // Opening Overnote cannot fix a refused socket, so the hint is status, which says why.
    expect(error.message).toMatch(/^refused the Overnote helper socket because its runtime dir or socket is not private to you/);
    expect(error.suggestions).toEqual(["overnote-axi status"]);
    expect(received).toEqual([]);
    chmodSync(runtimeDir, 0o700);
    expect(await errorOf(connectWriter(socket, runtimeDir, uid + 1))).toMatchObject({
      code: "HELPER_NOT_RUNNING",
      suggestions: ["overnote-axi status"],
    });
  });

  it("reports a stopped helper, not a refused one, when the runtime dir is missing", async () => {
    const gone = path.join(runtimeDir, "absent");
    expect(await errorOf(connectWriter(path.join(gone, "helper.sock"), gone, uid))).toMatchObject({
      code: "HELPER_NOT_RUNNING",
      suggestions: ["overnote-axi open"],
    });
  });

  it("probes running, stopped, and not answering within the budget", async () => {
    expect(await probeHelper(socket, runtimeDir, uid, 400)).toEqual({ state: "stopped" });
    await serve(echo);
    expect(await probeHelper(socket, runtimeDir, uid, 400)).toEqual({ state: "running", version: "9.9.9", pid: 77 });
    expect(await probeHelper(socket, runtimeDir, uid + 1, 400)).toEqual({ state: "stopped" });
    await new Promise((resolve) => server!.close(resolve));
    await serve(() => undefined);
    const started = Date.now();
    expect(await probeHelper(socket, runtimeDir, uid, 150)).toEqual({ state: "not-answering" });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("keeps connect plus ping within one probe budget", async () => {
    // A Unix socket connects almost at once, so this pins the total for a silent helper: the
    // ping is given only what the connect left, and the probe ends close to the budget.
    await serve(() => undefined);
    const started = Date.now();
    expect(await probeHelper(socket, runtimeDir, uid, 200)).toEqual({ state: "not-answering" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    // Below twice the budget: catches a ping that gets its own full budget, with room for jitter.
    expect(elapsed).toBeLessThan(400);
  });
});

describe("translateHelperError", () => {
  it("maps protocol and transport failures to stable codes without raw text", () => {
    const cases: [unknown, string][] = [
      [new RpcConnectionError("x", "connect"), "HELPER_NOT_RUNNING"],
      [new RpcConnectionError("x", "closed"), "OUTCOME_UNKNOWN"],
      [new RpcTimeoutError("notes.update"), "HELPER_TIMEOUT"],
      [new RpcError(404, "Note not found: /secret/path", "notes.get"), "NOTE_NOT_FOUND"],
      [new RpcError(409, "Note is in Recently Deleted: X", "notes.movePinnedUp"), "NOTE_TRASHED"],
      [new RpcError(409, "Note is not pinned: X", "notes.movePinnedDown"), "NOT_PINNED"],
      [new RpcError(409, "anything", "notes.pin"), "NOTE_TRASHED"],
      [new RpcError(409, "anything", "notes.update"), "HELPER_ERROR"],
      [new RpcError(500, "sqlite exploded at /secret/path", "notes.update"), "HELPER_ERROR"],
      [new Error("weird"), "HELPER_ERROR"],
    ];
    for (const [input, expected] of cases) {
      const error = translateHelperError(input);
      expect(error.code).toBe(expected);
      expect(error.message).not.toContain("/secret/path");
      expect(error.suggestions.length).toBeGreaterThan(0);
    }
    expect(translateHelperError(new RpcError(500, "x", "notes.update")).details).toEqual({ helperCode: 500 });
    const closed = translateHelperError(new RpcConnectionError("x", "closed"), "notes.update");
    expect(closed.code).toBe("OUTCOME_UNKNOWN");
    expect(closed.message).toMatch(/may or may not have landed/);
    expect(closed.suggestions[0]).toBe("overnote-axi read <id>");
    const closedCreate = translateHelperError(new RpcConnectionError("x", "closed"), "notes.create");
    expect(closedCreate.suggestions[0]).toBe("overnote-axi list --sort created");
    // A drop during a read changed nothing.
    expect(translateHelperError(new RpcConnectionError("x", "closed"), "notes.get").code).toBe("HELPER_NOT_RUNNING");
    expect(translateHelperError(new RpcConnectionError("x", "closed"), "system.ping").code).toBe("HELPER_NOT_RUNNING");
    for (const method of ["notes.create", "notes.duplicate"]) {
      const timeout = translateHelperError(new RpcTimeoutError(method));
      expect(timeout.code).toBe("HELPER_TIMEOUT");
      expect(timeout.message).toMatch(/may have landed/);
      expect(timeout.message).not.toMatch(/retry once/);
      expect(timeout.suggestions[0]).toBe("overnote-axi list --sort created");
    }
    expect(translateHelperError(new RpcTimeoutError("notes.update")).message).toMatch(/retry once/);
    expect(translateHelperError(new RpcConnectionError("x", "connect")).suggestions).toEqual(["overnote-axi open"]);
    const passthrough = new AxiError("kept", "STALE_WRITE");
    expect(translateHelperError(passthrough)).toBe(passthrough);
  });

  it("is applied by every writer call", async () => {
    const transport: RpcTransport = {
      call: () => Promise.reject(new RpcError(404, "gone", "notes.get")),
      close: () => undefined,
    };
    const writer = new HelperNotesWriter(transport);
    expect(await errorOf(writer.get("A"))).toMatchObject({ code: "NOTE_NOT_FOUND" });
    expect(await errorOf(writer.trash("A"))).toMatchObject({ code: "NOTE_NOT_FOUND" });
  });
});
