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
 *   addition's blocks are concatenated after (or before) its blocks, then `buildNoteContent`
 *   derives every stored field, so every existing node survives byte for byte;
 * - `edit` is block scoped: only the top level blocks whose own markdown contains the old text
 *   are serialized, edited, and parsed back, and only those blocks are checked for losses; a
 *   match that spans blocks falls back to rewriting the whole document;
 * - `update --replace` rewrites everything, so callers check `rewriteLosses` first and refuse
 *   with LOSSY_REWRITE (unless `--allow-loss`) when the round trip would change stored content.
 */
import type { JSONContent } from "@overnote/core";
import {
  buildNoteContent,
  docToMarkdown,
  loadDoc,
  markdownToDoc,
  noteContentFromMarkdown,
  UNKNOWN_BLOCK,
  UNKNOWN_INLINE,
  UNKNOWN_MARKS,
} from "@overnote/core";

import type { EditOutcome, MarkdownConverter, NoteContent, RewriteLoss, StoredNote } from "../domain/types.js";

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

/** Non overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
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

export const converter: MarkdownConverter = {
  fromMarkdown(markdown: string): NoteContent {
    return noteContentFromMarkdown(markdown);
  },

  normalize(markdown: string): string {
    return noteContentFromMarkdown(markdown).markdown;
  },

  compose(note: StoredNote, addition: string, mode: "append" | "prepend"): NoteContent {
    const base = blocks(loadStored(note), mode === "append" ? "end" : "start");
    const added = blocks(markdownToDoc(addition), "both");
    return buildNoteContent(docOf(mode === "append" ? [...base, ...added] : [...added, ...base]));
  },

  current(note: StoredNote): NoteContent {
    return buildNoteContent(loadStored(note));
  },

  rewriteLosses(note: StoredNote): RewriteLoss[] {
    return docLosses(loadStored(note));
  },

  edit(note: StoredNote, oldText: string, newText: string, all: boolean): EditOutcome {
    const doc = loadStored(note);
    const content = doc.content ?? [];
    const perBlock = content.map((block) => occurrences(docToMarkdown(single(block)), oldText));
    const inBlocks = perBlock.reduce((sum, count) => sum + count, 0);

    if (inBlocks === 0) {
      // The match may span blocks (for example two list items); then the whole note is rewritten.
      const markdown = buildNoteContent(doc).markdown;
      const matches = occurrences(markdown, oldText);
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
};
