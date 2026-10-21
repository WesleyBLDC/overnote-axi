# overnote-axi

A command line tool that lets coding agents read, search, create, update, organize, and link your [Overnote](https://github.com/WesleyBLDC/overnote) notes.

It follows the [AXI](https://github.com/kunchenguid/axi) standard: compact [TOON](https://toonformat.dev) output, definitive empty states, structured errors with stable exit codes, and next-step hints.
There is no server, no plugin, and no runtime dependency.
Reads come straight from Overnote's database (read-only), so they are instant and work while Overnote is closed.
Writes go through the running Overnote app, the single writer of its database, so the open editor reloads the note right away.
Appends and link inserts keep every existing block of a note exactly as stored, and rewrites that markdown cannot hold refuse with `LOSSY_REWRITE`.

If you are typing in the same note when an agent writes to it, Overnote (from protocol v2.14) merges the agent's change into your unsaved edits block by block instead of saving over it; where both changed the same block, it keeps both versions.
Older Overnote versions let the unsaved edit win, so the CLI warns whenever it writes to the note open in Overnote, checks the note again after the editor's save, and reports `OVERWRITTEN_BY_EDITOR` when its write was lost.

## Install

Needs macOS, Node 22.5 or newer, Overnote, and an Overnote checkout next to this one (the build bundles `@overnote/core` from it; set `OVERNOTE_DIR` to use another path).

```console
git clone https://github.com/WesleyBLDC/overnote ../overnote && (cd ../overnote && npm install)
npm install
npm run build
npm install -g .
```

`npm install -g .` puts `overnote-axi` on your `PATH`.
Install it before running `setup`: hooks and the installed skill then run the bare `overnote-axi`, which keeps working after a Node upgrade.
Without it, setup writes the absolute path of the current `node` and of `dist/overnote-axi.js` instead.

## Give your agent ambient context (pick one)

Both paths give an agent the same knowledge; you need only one.

- **Session hook (recommended):** `overnote-axi setup` adds a SessionStart hook to every agent whose config directory exists: Claude Code (`~/.claude/settings.json`), Codex (`$CODEX_HOME/hooks.json`, plus `hooks = true` under `[features]` in `config.toml`), and OpenCode (a managed plugin in `$XDG_CONFIG_HOME/opencode/plugins/`).
  Each session then starts with the output of `overnote-axi home --limit 3 --pinned-limit 3`: helper state, counts, the current note, and your pinned and recent notes.
  `--agent claude,codex,opencode` picks the agents; running setup again is safe and repairs a moved binary.
  `overnote-axi setup --uninstall` removes only what setup wrote, and leaves files it did not write alone.
  Codex runs a new hook only after you trust it: open Codex, run `/hooks`, and trust the `overnote-axi` hook (setup reminds you, and never trusts it for you).
- **Agent skill:** `overnote-axi setup skill` installs the `overnote-axi` skill for Claude Code at `~/.claude/skills/overnote-axi/SKILL.md`; it loads on demand (or as `/overnote-axi`) and costs nothing per session.
  Other agents can add it with `npx skills add WesleyBLDC/overnote-axi --skill overnote-axi`, which runs the skills installer, not this CLI.
  The skill calls the `overnote-axi` binary, so install it first (above).
  `overnote-axi setup skill --uninstall` removes it.

## Commands

| Command | What it does |
|---|---|
| `home` | Dashboard: helper state, counts, pinned and recent notes (the default) |
| `list` | List live notes, pinned first, or only pinned ones |
| `search` | Find notes whose title or text contains a query |
| `read` | Show one or more notes as markdown |
| `links` | Show the notes a note links to and the notes linking back |
| `status` | Helper, database and path diagnostics |
| `create` | Create a note from markdown |
| `update` | Append (default), prepend below the title, add on top (`--top`), or replace a note's markdown |
| `edit` | Replace exact text inside a note |
| `link` | Print a note's markdown link, or insert it into another note |
| `pin` | Pin a note to the end of the pinned list |
| `unpin` | Unpin a note |
| `move` | Move a pinned note up or down the pinned list |
| `duplicate` | Copy a note into a new note |
| `delete` | Move a note to Recently Deleted (`--permanent` erases it) |
| `recover` | Restore a note from Recently Deleted |
| `trash` | List Recently Deleted, or empty it with `--empty --permanent` |
| `open` | Show a note (or the last one) in the Overnote panel |
| `setup` | Install or remove the session hook (default) or the agent skill |

Every command takes `--help` (or `overnote-axi help <command>`), and flags go after the command.

A `<note>` argument is one of:

- `current`: the note open in Overnote, or the newest note when none is open;
- a full 26 character id;
- `title:<exact title>`;
- a unique id fragment of at least 6 characters.

Prefer the last 6 characters of an id: ids start with their creation time, so notes made close together share a prefix.

## Quick look

```console
overnote-axi                                   # helper state, counts, pinned and recent notes
overnote-axi read current                      # the note open in Overnote
overnote-axi search "standup"                  # title matches first
overnote-axi update K9QW7Z --content "- [ ] call Sam"
overnote-axi edit K9QW7Z --old "- [ ] call Sam" --new "- [x] call Sam"
overnote-axi link M1CX4P --into K9QW7Z
overnote-axi delete K9QW7Z                     # to Recently Deleted; recover brings it back
```

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success, including empty results and no-ops |
| 1 | The request was valid but could not be done (the output names the error `code`) |
| 2 | Usage error (`VALIDATION_ERROR`): unknown command or flag, bad value, missing argument |

A no-op (the note already holds what the write asked for) prints `(no-op; <reason>)` and exits 0.
Errors print on stdout as TOON with `error`, `code`, and `help` lines; nothing goes to stderr unless `OVERNOTE_AXI_DEBUG` is set.

## Development

```console
npm test            # unit, integration, and built binary tests (never touch your real notes)
npm run typecheck
npm run build       # dist/overnote-axi.js plus lazily loaded chunks
npm run check       # all of the above plus the skill staleness check
```

The integration tests start the real Overnote helper headless in a temp directory when `../overnote/helper/.build/release/OvernoteHelper` exists, and skip otherwise.
The build records the Overnote commit it bundled (shown by `overnote-axi status`) and writes `dist/THIRD_PARTY_LICENSES.txt` with the license of every bundled package.
`npm pack` refuses a checkout with uncommitted core changes unless `OVERNOTE_ALLOW_DIRTY=1`.
See [AGENTS.md](AGENTS.md) for contributor rules and [docs/DESIGN.md](docs/DESIGN.md) for the design.

## License

MIT
