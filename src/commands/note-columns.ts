/**
 * Row columns for note listings (`home`, `list`, `search`, `trash`), so a field such as
 * `pinned` or `preview` reads the same in every table. Pure: no I/O, no full core import.
 */
import { displayTitle } from "@overnote/core/text";

import type { NoteId, NoteSummary, NotesReader } from "../domain/types.js";
import { column, isoDate, type Cell, type Column } from "../output/render.js";
import type { SEARCH_FIELDS, TRASH_FIELDS } from "./shared.js";

/** Any note listing column (`trash` takes them all; `list` takes all but `deleted`). */
export type ListField = (typeof TRASH_FIELDS)[number];
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Code points of plain text a `preview` cell shows. */
export const PREVIEW_LENGTH = 100;

/** 1 based pin positions by note id, in the app's pin order. */
export type PinPositions = ReadonlyMap<NoteId, number>;

/** The title Overnote shows: the stored title, else the first line of text, else Untitled. */
export function summaryTitle(note: Pick<NoteSummary, "title" | "preview">): string {
  return displayTitle({ title: note.title, text: note.preview });
}

/** Collapses every whitespace run (newlines included) to one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The first PREVIEW_LENGTH code points of the note's text after its title line, on one line, so
 * the column adds what the title does not already show.
 */
export function previewOf(note: Pick<NoteSummary, "title" | "preview">): string {
  const text = note.preview.trimStart();
  const end = text.indexOf("\n");
  const first = (end === -1 ? text : text.slice(0, end)).trim();
  const body = first !== "" && first === summaryTitle(note) ? (end === -1 ? "" : text.slice(end + 1)) : text;
  return Array.from(oneLine(body)).slice(0, PREVIEW_LENGTH).join("");
}

/** Every live pinned note's position, read in one query (call inside the command's snapshot). */
export function pinPositions(reader: NotesReader): PinPositions {
  const { pinned } = reader.counts();
  if (pinned === 0) return new Map();
  const page = reader.list({ limit: pinned, pinnedOnly: true });
  return new Map(page.items.map((note, index) => [note.id, index + 1]));
}

/** Where a note sits in the pinned list. */
export interface PinPosition {
  /** 1 based place in the pinned list, or null when the note is not pinned. */
  position: number | null;
  total: number;
}

/** One note's place in the pinned list, from pinPositions (call inside the command's snapshot). */
export function pinPosition(reader: NotesReader, id: NoteId): PinPosition {
  const positions = pinPositions(reader);
  return { position: positions.get(id) ?? null, total: positions.size };
}

/** A nullable timestamp as a local date, or the empty string. */
function optionalDate(millis: number | null): Cell {
  return millis === null ? "" : isoDate(millis);
}

function pinCell(note: NoteSummary, positions: PinPositions): Cell {
  return note.pinned === null ? "" : (positions.get(note.id) ?? "");
}

/** The column for one list field; `positions` is only read by the `pinned` field. */
export function listColumn(field: ListField, positions: PinPositions): Column<NoteSummary> {
  switch (field) {
    case "id":
      return column(field, (note) => note.id);
    case "title":
      return column(field, summaryTitle);
    case "updated":
      return column(field, (note) => isoDate(note.updatedAt));
    case "created":
      return column(field, (note) => isoDate(note.createdAt));
    case "accessed":
      return column(field, (note) => optionalDate(note.lastAccessedAt));
    case "deleted":
      return column(field, (note) => optionalDate(note.deletedAt));
    case "chars":
      return column(field, (note) => note.charCount);
    case "pinned":
      return column(field, (note) => pinCell(note, positions));
    case "preview":
      return column(field, previewOf);
  }
}

/** Columns for `fields` in the order given, each field once. */
export function listColumns(fields: readonly ListField[], positions: PinPositions): Column<NoteSummary>[] {
  return [...new Set(fields)].map((field) => listColumn(field, positions));
}

/** Whether any of the fields needs pin positions (so the extra query runs only when it does). */
export function needsPinPositions(fields: readonly string[]): boolean {
  return fields.includes("pinned");
}
