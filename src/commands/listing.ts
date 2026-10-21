/**
 * The paged note table `list` and `trash` share: the definitive empty state, the past the end
 * state that points back at the first page, and the next page hint.
 */
import { rebuildInvocation } from "../args.js";
import { ok, type CommandOutput, type CommandSpec, type ParsedArgs } from "../command.js";
import type { NoteSummary, Page } from "../domain/types.js";
import { countNoun, joinBlocks, renderEmpty, renderHelp, renderList, type Column } from "../output/render.js";

export interface Listing {
  spec: CommandSpec;
  args: ParsedArgs;
  page: Page<NoteSummary>;
  offset: number;
  /** The table's TOON label, also used for the empty state (`notes`, `trash`). */
  label: string;
  /** What the rows are, for count lines (`live notes`, `notes in Recently Deleted`). */
  noun: string;
  columns: readonly Column<NoteSummary>[];
  /** Hints when there is nothing at all. */
  emptyHints: readonly string[];
  /** Hints after a page of rows, after the next page hint. */
  rowHints: readonly string[];
}

export function pagedListing(listing: Listing): CommandOutput {
  const { spec, args, page, offset, label, noun } = listing;
  if (page.total === 0) {
    return ok(joinBlocks([renderEmpty(label, `0 ${noun}`), renderHelp(listing.emptyHints)]));
  }
  if (page.items.length === 0) {
    // Paged past the end: say so definitively and point back at the first page.
    return ok(
      joinBlocks([
        renderEmpty("count", `0 of ${page.total} ${countNoun(page.total, noun)} (offset ${offset} is past the end)`),
        renderHelp([rebuildInvocation(spec, args, { offset: null })]),
      ]),
    );
  }
  const next = offset + page.items.length;
  const hints = [...(next < page.total ? [rebuildInvocation(spec, args, { offset: next })] : []), ...listing.rowHints];
  return ok(joinBlocks([renderList(label, page.items, listing.columns, { total: page.total, noun }), renderHelp(hints)]));
}
