/**
 * Static guidance shared by the home view and the generated skill (AXI principle 7: the skill
 * is the home view with live state stripped). Leaf module: data only, no imports.
 *
 * `HOME_HINTS` are the `help[N]:` lines the home view prints when notes exist; `WORKFLOW` and
 * `SAFETY` are the rules the skill body lists. Change them here and both outputs follow;
 * scripts/build-skill.mjs --check fails until SKILL.md is regenerated.
 */

export const HOME_HINTS: readonly string[] = [
  "overnote-axi read <id>",
  'overnote-axi search "<text>"',
  'overnote-axi create --content "<markdown>"',
];

/** The only hint when there are no notes yet. */
export const EMPTY_HOME_HINTS: readonly string[] = ['overnote-axi create --content "<markdown>"'];

export const WORKFLOW: readonly string[] = [
  "Run overnote-axi first: it shows helper state, counts, the current note, pinned and recent notes",
  'Find a note with overnote-axi search "<text>", then read it with overnote-axi read <id>',
  'Add to a note with overnote-axi update <id> --content "<markdown>" (append is the default and keeps every existing block)',
  'Check a task or fix a line with overnote-axi edit <id> --old "<exact markdown>" --new "<markdown>"',
  "Pass the updatedAt that read printed as --expected-updated-at so a concurrent edit fails with STALE_WRITE instead of being overwritten",
  "Link notes with overnote-axi link <id> --into <other id>",
];

export const SAFETY: readonly string[] = [
  "Reads work while Overnote is closed; writes need the running app (overnote-axi open starts it)",
  "A write to the note open in Overnote prints a warning: unsaved typing there can still win, and OVERWRITTEN_BY_EDITOR reports it when it does",
  "LOSSY_REWRITE means markdown cannot hold part of the note; prefer update (append) or a narrower edit over --allow-loss",
  "delete moves a note to Recently Deleted (recover restores it); only --permanent erases, and it needs the full id",
  "Exit codes: 0 success including no-ops, 1 error, 2 usage error; every error prints code and help lines",
];
