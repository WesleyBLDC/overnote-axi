/**
 * Note content conversion with @overnote/core, exactly as the editor does it.
 *
 * This module is the only place that imports the full core entry, and src/context.ts reaches it
 * through a dynamic import, so esbuild puts Tiptap and ProseMirror in their own chunk that read
 * commands never load.
 *
 * Markdown is lossy relative to `rawContent`: core's serializer writes nothing for preserved
 * unknown nodes, and its parser always produces expanded toggle lists. So content writes never
 * rebuild an existing note from its markdown:
 *
 * - append and prepend work on the document: the stored doc is loaded with `loadDoc` and the
 *   addition's blocks are concatenated after (append), after the title line (prepend), or before
 *   (top) its blocks, then `buildNoteContent` derives every stored field, so every existing node
 *   survives byte for byte;
 * - `edit` is block scoped: only the top level blocks whose own markdown contains the old text
 *   are serialized, edited, and parsed back, and only those blocks are checked for losses; when
 *   any match spans blocks (the whole note holds more matches than the blocks do), the edit is
 *   ambiguous without `--all` and rewrites the whole document with it;
 * - `update --replace` rewrites everything, so callers check `rewriteLosses` first and refuse
 *   with LOSSY_REWRITE (unless `--allow-loss`) when the round trip would change stored content;
 * - `duplicate --suffix` inserts the suffix into the loaded document's title line
 *   (`duplicateContent`), so the rest of the copy stays byte for byte.
 */
import type { JSONContent } from "@overnote/core";
import * as core from "@overnote/core";
import {
  buildNoteContent,
  docToMarkdown,
  getNoteSchema,
  loadDoc,
  markdownToDoc,
  noteContentFromMarkdown,
  UNKNOWN_BLOCK,
  UNKNOWN_INLINE,
  UNKNOWN_MARKS,
} from "@overnote/core";

import type { ComposeMode, EditOutcome, MarkdownConverter, NoteContent, RewriteLoss, StoredNote } from "../domain/types.js";
import { occurrences } from "./compose.js";

function isEmptyParagraph(node: JSONContent | undefined): boolean {
  return node?.type === "paragraph" && !(node.content?.length ?? 0);
}

/** Top level blocks without the empty paragraphs at the joining edge (the caret line). */
function blocks(doc: JSONContent, trim: "start" | "end" | "both"): JSONContent[] {
  const list = [...(doc.content ?? [])];
  if (trim !== "end") while (isEmptyParagraph(list[0])) list.shift();
  if (trim !== "start") while (isEmptyParagraph(list[list.length - 1])) list.pop();
  return list;
}

/** Heading and paragraph blocks can be a note's title line; lists, quotes and code cannot. */
const TITLE_BLOCKS = new Set(["heading", "paragraph"]);

/**
 * The index of the block that holds the note's title, when the first non empty block is a
 * heading or paragraph whose whole text is that one line; else null (prepend then goes on top).
 */
function titleBlockIndex(content: readonly JSONContent[]): number | null {
  const index = content.findIndex((block) => !isEmptyParagraph(block));
  const block = content[index];
  if (index === -1 || !block || !TITLE_BLOCKS.has(block.type ?? "")) return null;
  const text = buildNoteContent(single(block)).text.trim();
  return text !== "" && !text.includes("\n") ? index : null;
}

function loadStored(note: StoredNote): JSONContent {
  return loadDoc(note.rawContent, note.text);
}

/** Walks a loaded document and names what a markdown round trip cannot carry. */
function collectLosses(node: JSONContent, found: Set<RewriteLoss>): void {
  if (node.type === UNKNOWN_BLOCK || node.type === UNKNOWN_INLINE) found.add("unsupported-content");
  if (node.marks?.some((mark) => mark.type === UNKNOWN_MARKS)) found.add("unsupported-content");
  if (node.type === "list" && node.attrs?.collapsed === true) found.add("collapsed-toggle");
  for (const child of node.content ?? []) collectLosses(child, found);
}

/** Losses of rewriting `doc` through markdown; empty when the round trip is exact. */
function docLosses(doc: JSONContent): RewriteLoss[] {
  const found = new Set<RewriteLoss>();
  collectLosses(doc, found);
  if (found.size === 0) {
    const stored = buildNoteContent(doc);
    if (noteContentFromMarkdown(stored.markdown).rawContent !== stored.rawContent) found.add("formatting");
  }
  return [...found].sort();
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function single(block: JSONContent): JSONContent {
  return { type: "doc", content: [block] };
}

function docOf(content: JSONContent[]): JSONContent {
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/**
 * Each non empty top level block of a stored note, as a comparable key, counted. A multiset,
 * because notes repeat blocks (recurring checkbox items, separators, subheadings) and a write
 * that adds or removes one copy must still be checked.
 */
function blockCounts(note: StoredNote): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of loadStored(note).content ?? []) {
    if (isEmptyParagraph(block)) continue;
    const key = JSON.stringify(block);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

type DuplicateContent = (note: StoredNote, titleSuffix: string) => NoteContent;

/**
 * Core's `duplicateContent` (Overnote protocol v3.0) when the bundled core has it. Read off an
 * opaque view of the namespace, so a core without it builds without an undefined import.
 */
const coreExports: Readonly<Record<string, unknown>> = core;
const coreDuplicateContent = coreExports["duplicateContent"] as DuplicateContent | undefined;

function isTextblock(node: JSONContent): boolean {
  return getNoteSchema().nodes[node.type ?? ""]?.isTextblock === true;
}

/** Whether a textblock contributes to the plain text: some text or a hard break. */
function hasPlainText(block: JSONContent): boolean {
  return (block.content ?? []).some((child) => (child.type === "text" && !!child.text) || child.type === "hardBreak");
}

/**
 * The first textblock with plain text in document order (the one the title comes from, since
 * deriveTitle skips empty blocks), else the first textblock, else null.
 */
function titleTextblock(doc: JSONContent): JSONContent | null {
  let first: JSONContent | null = null;
  const visit = (node: JSONContent): JSONContent | null => {
    if (isTextblock(node)) {
      first ??= node;
      return hasPlainText(node) ? node : null;
    }
    for (const child of node.content ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(doc) ?? first;
}

/**
 * Inserts `suffix` as unmarked text into a textblock's first line (which ends at a hard break or
 * a newline inside its text), right after its last non space character, or at the block's start
 * without its leading spaces when that line is blank. Mutates `block`.
 */
function insertIntoFirstLine(block: JSONContent, suffix: string): void {
  const children = block.content ?? [];
  let at: { index: number; offset: number } | null = null;
  for (const [index, child] of children.entries()) {
    if (child.type === "hardBreak") break;
    if (child.type !== "text") continue;
    const text = child.text ?? "";
    const newline = text.indexOf("\n");
    const kept = (newline === -1 ? text : text.slice(0, newline)).trimEnd().length;
    if (kept > 0) at = { index, offset: kept };
    if (newline !== -1) break;
  }
  if (at === null) {
    // A blank title line starts with the suffix, without its leading space.
    const text = suffix.trimStart();
    if (text !== "") block.content = [{ type: "text", text }, ...children];
    return;
  }
  const inserted: JSONContent = { type: "text", text: suffix };
  const target = children[at.index]!;
  const text = target.text ?? "";
  const pieces = [{ ...target, text: text.slice(0, at.offset) }, inserted];
  if (at.offset < text.length) pieces.push({ ...target, text: text.slice(at.offset) });
  block.content = [...children.slice(0, at.index), ...pieces, ...children.slice(at.index + 1)];
}

/**
 * The same rule as core's `duplicateContent`, for a bundled core that predates it: the suffix
 * goes at the end of the line the title comes from and every field is derived from the result,
 * so the title, rawContent, markdown, and text agree and a later save keeps the suffixed title.
 */
export function suffixedContent(note: StoredNote, suffix: string): NoteContent {
  const doc = structuredClone(loadStored(note));
  const block = suffix === "" ? null : titleTextblock(doc);
  if (block) insertIntoFirstLine(block, suffix);
  return buildNoteContent(doc);
}

export const converter: MarkdownConverter = {
  fromMarkdown(markdown: string): NoteContent {
    return noteContentFromMarkdown(markdown);
  },

  normalize(markdown: string): string {
    return noteContentFromMarkdown(markdown).markdown;
  },

  compose(note: StoredNote, addition: string, mode: ComposeMode): NoteContent {
    const added = blocks(markdownToDoc(addition), "both");
    if (mode === "append") return buildNoteContent(docOf([...blocks(loadStored(note), "end"), ...added]));
    const base = blocks(loadStored(note), "start");
    const title = mode === "prepend" ? titleBlockIndex(base) : null;
    if (title === null) return buildNoteContent(docOf([...added, ...base]));
    return buildNoteContent(docOf([...base.slice(0, title + 1), ...added, ...base.slice(title + 1)]));
  },

  belowTitle(note: StoredNote): string | null {
    const base = blocks(loadStored(note), "start");
    const title = titleBlockIndex(base);
    if (title === null) return null;
    return buildNoteContent(docOf(blocks(docOf(base.slice(title + 1)), "start"))).markdown;
  },

  current(note: StoredNote): NoteContent {
    return buildNoteContent(loadStored(note));
  },

  rewriteLosses(note: StoredNote): RewriteLoss[] {
    return docLosses(loadStored(note));
  },

  duplicateContent(note: StoredNote, suffix: string): NoteContent {
    return (coreDuplicateContent ?? suffixedContent)(note, suffix);
  },

  edit(note: StoredNote, oldText: string, newText: string, all: boolean): EditOutcome {
    const doc = loadStored(note);
    const content = doc.content ?? [];
    const perBlock = content.map((block) => occurrences(docToMarkdown(single(block)), oldText));
    const inBlocks = perBlock.reduce((sum, count) => sum + count, 0);
    const markdown = buildNoteContent(doc).markdown;
    const matches = occurrences(markdown, oldText);

    if (inBlocks === 0 || matches > inBlocks) {
      // Some match spans blocks (for example two list items); then the whole note is rewritten,
      // and the count is the whole note's, so a block match never hides a spanning one.
      if (matches === 0) return { status: "not-found" };
      if (matches > 1 && !all) return { status: "ambiguous", matches };
      return {
        status: "ok",
        scope: "document",
        replaced: matches,
        losses: docLosses(doc),
        content: noteContentFromMarkdown(replaceAll(markdown, oldText, newText)),
      };
    }
    if (inBlocks > 1 && !all) return { status: "ambiguous", matches: inBlocks };

    const losses = new Set<RewriteLoss>();
    const next: JSONContent[] = [];
    content.forEach((block, index) => {
      if ((perBlock[index] ?? 0) === 0) {
        next.push(block);
        return;
      }
      for (const loss of docLosses(single(block))) losses.add(loss);
      const edited = replaceAll(docToMarkdown(single(block)), oldText, newText);
      next.push(...blocks(markdownToDoc(edited), "both"));
    });
    return {
      status: "ok",
      scope: "blocks",
      replaced: inBlocks,
      losses: [...losses].sort(),
      content: buildNoteContent(docOf(next)),
    };
  },

  writeSurvived(before: StoredNote, written: StoredNote, after: StoredNote): boolean {
    if (after.rawContent === written.rawContent) return true;
    const old = blockCounts(before);
    const ours = blockCounts(written);
    const now = blockCounts(after);
    for (const key of new Set([...old.keys(), ...ours.keys()])) {
      const was = old.get(key) ?? 0;
      const wrote = ours.get(key) ?? 0;
      const is = now.get(key) ?? 0;
      // Copies the write added must still be there; copies it removed must still be gone.
      if (wrote > was && is < wrote) return false;
      if (wrote < was && is > wrote) return false;
    }
    return true;
  },
};
