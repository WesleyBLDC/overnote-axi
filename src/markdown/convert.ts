/**
 * Markdown to stored note content with @overnote/core, exactly as the editor does it
 * (slice: foundation). This module is the only place that imports the full core entry, and
 * src/context.ts reaches it through a dynamic import, so esbuild puts Tiptap and ProseMirror in
 * their own chunk that read commands never load.
 */
import { noteContentFromMarkdown } from "@overnote/core";

import type { MarkdownConverter, NoteContent } from "../domain/types.js";

export const converter: MarkdownConverter = {
  fromMarkdown(markdown: string): NoteContent {
    return noteContentFromMarkdown(markdown);
  },
};
