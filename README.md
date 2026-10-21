# overnote-axi

A command line tool that lets coding agents read, search, create, update, organize, and link your [Overnote](https://github.com/WesleyBLDC/overnote) notes.

It follows the [AXI](https://github.com/kunchenguid/axi) standard: compact [TOON](https://toonformat.dev) output, definitive empty states, structured errors with stable exit codes, and next-step hints.
There is no server, no plugin, and no runtime dependency.
Reads come straight from Overnote's database (read-only), so they are instant and work while Overnote is closed.
Writes go through the running Overnote app, the single writer of its database, so the open editor reloads the note right away.
Appends and link inserts keep every existing block of a note exactly as stored, and rewrites that markdown cannot hold refuse with `LOSSY_REWRITE`.

One limit to know: if you are typing in the same note when an agent writes to it, your unsaved edit wins, because the editor saves its own content over the change.
The CLI warns when it writes to the note open in Overnote, and reports `OVERWRITTEN_BY_EDITOR` when the editor saved over its write.

> Status: scaffold.
> The command surface is specified in [docs/DESIGN.md](docs/DESIGN.md) and is being implemented.

## Install

Needs macOS, Node 22.5 or newer, Overnote, and an Overnote checkout next to this one (the build bundles `@overnote/core` from it).

```console
git clone https://github.com/WesleyBLDC/overnote ../overnote && (cd ../overnote && npm install)
npm install
npm run build
npm install -g .
```

## Give your agent ambient context (pick one)

Both paths give an agent the same knowledge; you need only one.

- **Session hook (recommended):** `overnote-axi setup` adds a SessionStart hook to Claude Code, Codex, and OpenCode (whichever you have), so every session starts with your pinned and recent notes in view.
  `overnote-axi setup --uninstall` removes it.
- **Agent skill:** `overnote-axi setup skill` installs the `overnote-axi` skill for Claude Code, which loads on demand (or as `/overnote-axi`) and costs nothing per session.
  Other agents can add it with `npx skills add WesleyBLDC/axi-overnote --skill overnote-axi` once the repository is public.
  The skill calls the installed `overnote-axi` binary, so install it first (above).

## Quick look

```console
overnote-axi                                   # helper state, counts, pinned and recent notes
overnote-axi search "standup"                  # title matches first
overnote-axi read current                      # the note open in Overnote
overnote-axi update current --content "- [ ] call Sam"
overnote-axi edit current --old "- [ ] call Sam" --new "- [x] call Sam"
overnote-axi link <id> --into current
overnote-axi delete <id>                       # to Recently Deleted; --permanent erases
```

Every command takes `--help`.

## Development

```console
npm test            # unit and integration tests (never touch your real notes)
npm run typecheck
npm run build       # dist/overnote-axi.js plus lazily loaded chunks
npm run check       # all of the above plus the skill staleness check
```

`OVERNOTE_DIR` points the build at a different Overnote checkout.
The build records the Overnote commit it bundled (shown by `overnote-axi status`) and writes `dist/THIRD_PARTY_LICENSES.txt` with the license of every bundled package.
`npm pack` refuses a checkout with uncommitted core changes unless `OVERNOTE_ALLOW_DIRTY=1`.
See [AGENTS.md](AGENTS.md) for contributor rules.

## License

MIT
