# Contributor and agent instructions

## Read first

- [docs/DESIGN.md](docs/DESIGN.md) is the design of record: command surface, output, errors, safety, testing, and the module map.
- Overnote's `docs/architecture.md` (in the Overnote checkout) defines the socket protocol, data types, and database schema this CLI relies on.

## Rules

- Never write to real notes or real agent config: tests run with the isolated environment of `test/setup.ts` (temp Overnote dirs, temp `HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME`, and `OVERNOTE_AXI_OPEN_CMD=/usr/bin/true`); never unset it, and pass every fixture path through `assertIsolated()`.
- Never rebuild an existing note from its markdown: append, prepend and link go through `converter.compose`, `edit` through `converter.edit`, and full rewrites check `rewriteLosses` first (docs/DESIGN.md section 3.1).
- Never write to the database directly; every write goes through the helper (`NotesWriter`).
- Keep runtime `dependencies` empty; bundle at build time instead.
- Keep `bin/overnote-axi.ts` statically importing only `src/version.ts`.
- Only `src/markdown/convert.ts` may import the full `@overnote/core` entry; everything else uses `@overnote/core/text` or type-only imports.
- stdout is TOON only and goes through `src/output/render.ts`; never print raw dependency errors.
- Every command module declares its flags in its `CommandSpec`; do not parse argv by hand.
- Prose (docs, comments, messages, help text): never use dashes as punctuation (hyphens inside compound words are fine), and put each sentence of a long Markdown file on its own line.
- `npm run check` must pass before a commit; treat lint errors, failing tests, and flaky tests as defects.
- Clean room: reuse code only from the public Overnote repository.
