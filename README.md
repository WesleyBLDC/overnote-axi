# overnote-axi

A command line tool that lets coding agents read, search, create, update, organize, and link your [Overnote](https://github.com/WesleyBLDC/overnote) notes.

It follows the [AXI](https://github.com/kunchenguid/axi) standard: compact [TOON](https://toonformat.dev) output, definitive empty states, structured errors with stable exit codes, and next-step hints.
There is no server, no plugin, and no runtime dependency.
Reads come straight from Overnote's database (read-only), so they are instant and work while Overnote is closed.
Writes go through the running Overnote app, so the note you have open updates live and nothing races the app.

> Status: scaffold.
> The command surface is specified in [docs/DESIGN.md](docs/DESIGN.md) and is being implemented.

## Install

Needs macOS, Node 22 or newer, Overnote, and an Overnote checkout next to this one (the build bundles `@overnote/core` from it).

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
- **Agent skill:** `overnote-axi setup skill` installs the `overnote-axi` skill, which loads on demand (or as `/overnote-axi`) and costs nothing per session.

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
See [AGENTS.md](AGENTS.md) for contributor rules.

## License

MIT
