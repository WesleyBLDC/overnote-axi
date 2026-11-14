# Contributor and agent instructions

## Read first

- [docs/DESIGN.md](docs/DESIGN.md) is the design of record: command surface, output, errors, safety, testing, and the module map.
- Overnote's `docs/architecture.md` (in the Overnote checkout) defines the socket protocol, data types, and database schema this CLI relies on.
- [docs/architecture/system-design.md](docs/architecture/system-design.md) shows where this CLI sits in the whole Overnote system (C4 views and data flows); it is a copy of the one in the Overnote repository.

## Rules

- Never write to real notes or real agent config: tests run with the isolated environment of `test/setup.ts` (temp Overnote dirs, temp `HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME`, and `OVERNOTE_AXI_OPEN_CMD=/usr/bin/true`); never unset it, and pass every fixture path through `assertIsolated()`.
- Never rebuild an existing note from its markdown: append, prepend and link go through `converter.compose`, `edit` through `converter.edit`, and full rewrites check `rewriteLosses` first (docs/DESIGN.md section 3.1).
- Never write to the database directly; every write goes through the helper (`NotesWriter`).
- Keep runtime `dependencies` empty; bundle at build time instead.
- Keep `bin/overnote-axi.ts` statically importing only `src/version.ts`.
- Only `src/markdown/convert.ts` may import the full `@overnote/core` entry; everything else uses `@overnote/core/text` or type-only imports.
- stdout is TOON only and goes through `src/output/render.ts`; never print raw dependency errors.
- Every command module declares its flags in its `CommandSpec`; do not parse argv by hand.
- Prettier formats every file it supports (Markdown excluded); Claude Code's hook in `.claude/settings.json` formats each edited file, and other agents run `npx prettier --write <files>`.
- Prose (docs, comments, messages, help text): never use dashes as punctuation (hyphens inside compound words are fine), and put each sentence of a long Markdown file on its own line.
- `npm run check` must pass before a commit; treat lint errors, failing tests, and flaky tests as defects.
- `main` only moves through a merged pull request: work on a branch and open one; never push to `main` or force push.
  To catch up with `main`, merge `origin/main` into the branch rather than rebasing a pushed branch.
- Clean room: reuse code only from the public Overnote repository.

## Keeping docs and rules current

Docs describe what is on `main` today, never what used to be.

- Every merge updates the docs it changes in the same pull request: this file, `README.md`, `docs/DESIGN.md` (command surface, paths, testing, module map), and `docs/architecture/system-design.md`.
- Prune as you go: delete rules, paragraphs, and table rows that no longer match the code, instead of adding a correction next to them.
- Keep this file short: a rule earns its line only if an agent would get it wrong without it.

## Learning

Turn every mistake or better way into a durable fix, so the next agent does not repeat it.

- When a guard blocks you, a review finds a bug, a test was flaky, or you find a faster workflow, add one line in the same pull request: a rule here, a step in a skill under `.claude/skills/`, or a check in `npm run check` when it can be automated.
- Prefer automating the lesson (a script, a test, a lint rule) over writing it down.
- Repo skill: `.claude/skills/ship-change` (branch to merged pull request with docs); update it when its steps go stale.

A lead session reads `lead.toml` and the rules it names; workers can ignore it.
