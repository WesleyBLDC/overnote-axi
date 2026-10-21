/**
 * Static guidance shared by the CLI help, the home view, and the generated skill (AXI principle 7:
 * the skill is the home view with live state stripped). Leaf module: data only, no imports.
 *
 * `HOME_HINTS` are the `help[N]:` lines the home view prints when notes exist; `NOTE_REF_HELP` is
 * the note reference rule the top-level help and the skill print; `WORKFLOW` and `SAFETY` are the
 * lists the skill body renders. Change them here and every output follows;
 * scripts/build-skill.mjs --check fails until SKILL.md is regenerated.
 */

export const HOME_HINTS: readonly string[] = [
  "overnote-axi read <id>",
  'overnote-axi search "<text>"',
  'overnote-axi create --content "<markdown>"',
];

/** The only hint when there are no notes yet. */
export const EMPTY_HOME_HINTS: readonly string[] = ['overnote-axi create --content "<markdown>"'];

/**
 * How a `<note>` argument is written. Suffixes are recommended because a ULID starts with its
 * creation time, so notes made close together share a prefix.
 */
export const NOTE_REF_HELP =
  "<note> is current (the note open in Overnote, else the newest note), a full id, title:<exact title>, " +
  "or a unique id fragment of 6+ chars; prefer the last 6 chars of the id, since notes made close together share a prefix";

/** The steps after `overnote-axi` itself, in the order an agent usually takes them. */
export const WORKFLOW: readonly string[] = [
  'Add to a note with `overnote-axi update <id> --content "<markdown>"`; `--prepend` inserts right after the title line, so the title stays, and `--top` puts the content above the title, which renames the note',
  'Check a task or fix a line with `overnote-axi edit <id> --old "<exact markdown>" --new "<markdown>"`; a retry of a whole line edit that already landed is a no-op',
  "Pass the `updatedAt` that `read` printed as `--expected-updated-at`, so a concurrent edit fails with `STALE_WRITE` instead of being overwritten",
  "Link notes with `overnote-axi link <id> --into <other id>`",
];

/** One list: every rule about what an agent may write, erase, or touch. */
export const SAFETY: readonly string[] = [
  "Append by default: `update` appends unless told otherwise, and keeps every existing block exactly as stored",
  "`edit` is block scoped: only the blocks containing `--old` are rewritten, so prefer it for checking a task or fixing a line",
  "Use `update --replace` or `delete` only when the user asks for a rewrite or a deletion of that note; `--replace` also needs the `--expected-updated-at` that `read` printed",
  "`LOSSY_REWRITE` means markdown cannot hold part of the note; prefer `update` (append) or a narrower `edit` over `--allow-loss`",
  "`delete` moves a note to Recently Deleted for 60 days and `recover <id>` restores it, so say so when you delete",
  "Pass `--permanent` (`delete --permanent <full id>`, `trash --empty --permanent --expected-count <n>`) only when the user explicitly asked in this conversation to erase notes for good; never infer it from \"delete\" or \"clean up\", and no hint ever offers it",
  "A write to the note open in Overnote prints a warning: Overnote merges it with unsaved typing, and an older Overnote that saves over it is reported as `OVERWRITTEN_BY_EDITOR`",
  "Never read or write Overnote's database or files directly, and never drive the Raycast window; this CLI is the only interface",
];
