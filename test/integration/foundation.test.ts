/**
 * The foundation against the real OvernoteHelper (test/fixtures/temp-helper.ts): the socket
 * client, the writer's error translation, the trust checks, and the read-only reader all run
 * against what the helper actually does, in throwaway directories. Skips when the helper binary
 * is not built.
 */
import { lstatSync } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePaths } from "../../src/config/paths.js";
import { createRuntimeContext } from "../../src/runtime.js";
import type { NoteContent, NotesWriter } from "../../src/domain/types.js";
import { AxiError } from "../../src/errors.js";
import { connectWriter, probeHelper } from "../../src/helper/notes-writer.js";
import { PROBE_TIMEOUT_MS } from "../../src/helper/rpc-client.js";
import { openReader } from "../../src/store/readonly-db.js";
import { resolveNote } from "../../src/store/refs.js";
import { assertIsolated } from "../fixtures/guard.js";
import { HELPER_MISSING, helperBinary, startTempHelper, type TempHelper } from "../fixtures/temp-helper.js";

const uid = os.userInfo().uid;
const available = helperBinary() !== null;

function content(body: string): NoteContent {
  const lines = body.split("\n");
  const doc = {
    type: "doc",
    content: lines.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
  return { rawContent: JSON.stringify(doc), markdown: body, text: body, title: lines.find((line) => line.trim())?.trim() ?? "" };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AxiError ? error.code : "raw";
  }
}

const title = "foundation against the real helper";

describe.skipIf(!available)(available ? title : `${title} (skipped: ${HELPER_MISSING})`, () => {
  let helper: TempHelper;
  let writer: NotesWriter;

  beforeAll(async () => {
    helper = await startTempHelper();
    writer = await connectWriter(helper.socket, helper.runtimeDir, uid);
  });

  afterAll(async () => {
    writer?.close();
    await helper?.cleanup();
  });

  it("runs in an isolated private runtime dir", () => {
    for (const value of [helper.root, helper.supportDir, helper.socket, helper.backupDir]) {
      expect(() => assertIsolated(value)).not.toThrow();
    }
    expect(lstatSync(helper.runtimeDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(helper.socket).isSocket()).toBe(true);
    expect(resolvePaths({ env: helper.env(), home: "/nowhere", uid })).toMatchObject({
      database: helper.database,
      socket: helper.socket,
    });
  });

  it("probes and pings a running helper", async () => {
    const probe = await probeHelper(helper.socket, helper.runtimeDir, uid, PROBE_TIMEOUT_MS);
    expect(probe).toEqual({ state: "running", version: expect.any(String), pid: helper.pid });
    expect(await writer.ping()).toEqual({ version: probe.state === "running" ? probe.version : "", pid: helper.pid });
    const status = await writer.status();
    expect(status).toMatchObject({ pid: helper.pid, schemaVersion: 1, noteCount: 0, backupDir: helper.backupDir });
  });

  it("writes through the helper and reads the same state back from SQLite", async () => {
    const created = await writer.create(content("Café plan\nbuy beans"));
    expect(created).toMatchObject({ title: "Café plan", pinned: null, deletedAt: null });

    const reader = openReader(helper.database)!;
    try {
      expect(reader.schemaVersion()).toBe(1);
      expect(reader.get(created.id)).toEqual(created);
      expect(reader.counts()).toEqual({ live: 1, pinned: 0, trashed: 0 });
      expect(reader.search("CAFE", { limit: 5 }).items.map((hit) => [hit.note.id, hit.titleMatch])).toEqual([
        [created.id, true],
      ]);
      // notes.setCurrentNote persists the current note, and the reader resolves `current` from settings.
      await writer.setCurrentNote(created.id);
      expect(reader.currentNoteId()).toBe(created.id);
      expect(resolveNote(reader, "current", { allowTrashed: false }).id).toBe(created.id);
      expect(resolveNote(reader, created.id.slice(-8), { allowTrashed: false }).id).toBe(created.id);
      expect(resolveNote(reader, "title:cafe PLAN", { allowTrashed: false }).id).toBe(created.id);
    } finally {
      reader.close();
    }
  });

  it("updates with the stale write token and reports conflicts without writing", async () => {
    const note = await writer.create(content("Token note"));
    const ok = await writer.update({ id: note.id, expectedUpdatedAt: note.updatedAt, ...content("Token note\nmore") });
    expect(ok.status).toBe("ok");
    expect(ok.note.updatedAt).toBeGreaterThan(note.updatedAt);

    const stale = await writer.update({ id: note.id, expectedUpdatedAt: note.updatedAt, ...content("lost") });
    expect(stale).toEqual({ status: "conflict", note: ok.note });
    expect((await writer.get(note.id)).text).toBe("Token note\nmore");
  });

  it("pins, moves, trashes, recovers and erases with the codes the CLI documents", async () => {
    const first = await writer.create(content("First pin"));
    const second = await writer.create(content("Second pin"));
    expect((await writer.pin(first.id)).pinned).toBe(1000);
    expect((await writer.pin(second.id)).pinned).toBe(2000);
    await writer.movePinned(second.id, "up");
    expect((await writer.get(second.id)).pinned).toBe(1000);
    // At the top end the helper does nothing.
    await writer.movePinned(second.id, "up");
    expect((await writer.get(second.id)).pinned).toBe(1000);

    const loose = await writer.create(content("Loose"));
    expect(await codeOf(writer.movePinned(loose.id, "down"))).toBe("NOT_PINNED");
    expect((await writer.unpin(first.id)).pinned).toBeNull();

    await writer.trash(loose.id);
    expect(await codeOf(writer.pin(loose.id))).toBe("NOTE_TRASHED");
    expect(await codeOf(writer.movePinned(loose.id, "up"))).toBe("NOTE_TRASHED");
    expect((await writer.recover(loose.id)).deletedAt).toBeNull();

    // permanentlyDelete leaves live notes alone; only the trash is erased.
    await writer.permanentlyDelete(loose.id);
    expect((await writer.get(loose.id)).id).toBe(loose.id);
    await writer.trash(loose.id);
    await writer.permanentlyDelete(loose.id);
    expect(await codeOf(writer.get(loose.id))).toBe("NOTE_NOT_FOUND");
    expect(await codeOf(writer.permanentlyDelete(loose.id))).toBe("NOTE_NOT_FOUND");

    const copy = await writer.duplicate(first.id);
    expect(copy).toMatchObject({ title: first.title, markdown: first.markdown, rawContent: first.rawContent, pinned: null });
    await writer.trash(copy.id);
    await writer.trash(first.id);
    expect(await writer.emptyTrash()).toBe(2);
    expect(await writer.emptyTrash()).toBe(0);

    const reader = openReader(helper.database)!;
    try {
      expect(reader.listTrashed({ limit: 10 }).total).toBe(0);
      expect(reader.list({ limit: 10, pinnedOnly: true }).items.map((note) => note.id)).toEqual([second.id]);
    } finally {
      reader.close();
    }
  });

  it("maps a missing note to NOTE_NOT_FOUND for every note method", async () => {
    const missing = "01JAB00000000000000000ZZZZ";
    const calls: (() => Promise<unknown>)[] = [
      () => writer.get(missing),
      () => writer.update({ id: missing, ...content("x") }),
      () => writer.trash(missing),
      () => writer.recover(missing),
      () => writer.duplicate(missing),
      () => writer.pin(missing),
      () => writer.unpin(missing),
      () => writer.movePinned(missing, "down"),
    ];
    for (const call of calls) expect(await codeOf(call())).toBe("NOTE_NOT_FOUND");
  });

  it("works through the production Context", async () => {
    const context = createRuntimeContext({ env: { ...process.env, ...helper.env() } });
    try {
      expect(await context.probeHelper()).toMatchObject({ state: "running", pid: helper.pid });
      const note = await (await context.writer()).create(content("From the context"));
      expect(context.reader().snapshot((reader) => reader.get(note.id)?.title)).toBe("From the context");
    } finally {
      context.close();
    }
  });

  it("reports a stopped helper as stopped and refuses writes, while reads keep working", async () => {
    const before = openReader(helper.database)!;
    const live = before.counts().live;
    before.close();

    await helper.stop();
    expect(await probeHelper(helper.socket, helper.runtimeDir, uid, PROBE_TIMEOUT_MS)).toEqual({ state: "stopped" });
    expect(await codeOf(connectWriter(helper.socket, helper.runtimeDir, uid))).toBe("HELPER_NOT_RUNNING");
    expect(await codeOf(writer.ping())).toBe("HELPER_NOT_RUNNING");

    const after = openReader(helper.database)!;
    try {
      expect(after.counts().live).toBe(live);
    } finally {
      after.close();
    }
  });
});
