# overnote-axi design

This is the design of record for `overnote-axi`, an [AXI](https://github.com/kunchenguid/axi) compliant command line tool that lets coding agents work with [Overnote](https://github.com/WesleyBLDC/overnote) notes.
Code and this document change together.
Protocol details it relies on live in the Overnote repo's `docs/architecture.md` (cited below as "architecture §N").

## 1. Goals

- Give agents full CRUD over Overnote notes: create, read, search, update, organize (pin, unpin, reorder, duplicate), link, delete to Recently Deleted, recover, and permanent deletion behind an explicit flag.
- Follow every AXI principle: TOON output, minimal default schemas, truncation with `--full`, aggregates, definitive empty states, structured errors with stable codes, no prompts, loud failure on unknown input, content first, next-step hints, concise per-command help, and ambient context through a session hook.
- Keep Overnote the single writer: every write goes through the running Overnote helper over its socket, so the open editor reloads the note right away.
  The one race that remains (a person typing in the same note) is stated in section 7 and reported, never hidden.
- Make reads instant and available while Overnote is closed, by reading the database directly with read-only `node:sqlite`.
- Store content exactly as the editor would, by converting with `@overnote/core` itself, and never lose stored content through a markdown round trip without saying so (section 3.1).
- Ship as one bundled `dist/` with zero runtime dependencies, no daemon, no server, and no plugin.
- Replace hand-written agent instructions about Overnote with an installable `overnote-axi` skill (usable as `/overnote-axi`).

## 2. Non-goals

- No MCP server, no background process, no network access.
- No direct database writes, ever, even when Overnote is closed.
- No editing of settings, backups, restore, or window layout; Overnote's own commands cover those.
- No folders or tags: Overnote has neither, so "organize" means pins, order, copies, and trash.
- No interactive prompts or confirmations; destructive operations need explicit flags instead.
- No support outside macOS (Overnote is macOS only).
- No reuse of anything from outside the public Overnote repository (clean room, see Overnote `docs/clean-room.md`).
- No directory scoped context: Overnote notes are global and have no link to a project, so the home payload is the same in every directory and `setup` installs user level hooks only (no project `.claude/settings.json`).
- No SessionEnd or other lifecycle capture hooks: writing into notes without the person asking would break the explicit opt in rule of section 8.
- No `npx` invocation of this CLI anywhere (skill, hooks, docs) until the npm name is published and owned by this project, because `npx` would fetch whatever a stranger publishes under the name.

## 3. Architecture

```
bin/overnote-axi.ts ── --version fast path, else dynamic import ──▶ src/cli.ts
                                                                     │ registry: lazy command modules
                                                                     ▼
                                                     src/commands/<name>.ts (spec + run)
                                                                     │ Context ports
                       ┌─────────────────────────────────────────────┼─────────────────────────────┐
                       ▼                                             ▼                             ▼
          NotesReader (read-only node:sqlite)         NotesWriter (helper socket RPC)     MarkdownConverter
          src/store/readonly-db.ts                    src/helper/notes-writer.ts          src/markdown/convert.ts
                       │                                             │                     (@overnote/core chunk)
                       ▼                                             ▼
   <support dir>/notes.sqlite (WAL, owned by helper)   /tmp/overnote-<uid>/helper.sock ──▶ OvernoteHelper
```

### 3.1 Data path

- **Reads** (`home`, `list`, `search`, `read`, `links`, `trash` listing, `status` database facts, and reference resolution) open `<support dir>/notes.sqlite` with `node:sqlite` `readOnly: true`, then `PRAGMA query_only = ON` and `PRAGMA busy_timeout = 1000`.
  This is the access the app itself allows (architecture §6: "The extension may open the database read-only").
  WAL mode means a reader sees the last committed state without blocking the helper.
- **Writes** (`create`, `update`, `edit`, `link --into`, `pin`, `unpin`, `move`, `duplicate`, `delete`, `recover`, `trash --empty`) call the helper's `notes.*` methods over newline-delimited JSON-RPC on `/tmp/overnote-<uid>/helper.sock` (architecture §2 and §5).
  The helper emits `notes.changed`, so an open editor reloads the note immediately.
- **Fresh reads before writes.** A write that depends on current content (`update`, `edit`, `link --into`) fetches the note with `notes.get` through the helper, not from SQLite, checks `deletedAt` again (a note trashed after resolution is `NOTE_TRASHED`), and sends `expectedUpdatedAt` with the value it just read, so a concurrent write yields a conflict instead of a lost update.
  All three share one flow, `writeContent` in `src/commands/write-flow.ts` (section 7).
- **Content conversion.** Every stored field (`rawContent`, `markdown`, `text`, `title`) comes from `@overnote/core`, the same code the editor and the Raycast commands use (architecture §7).
  The helper never parses content, so this is the only correct way to produce it.
- **Markdown is lossy, so existing notes are never rebuilt from it.** Core's serializer writes nothing for the placeholders that preserve unknown nodes, and its parser always produces expanded toggle lists, so rebuilding a note from its own markdown can delete content or reopen a collapsed toggle.
  The `MarkdownConverter` port (`src/markdown/convert.ts`) therefore works on the document:
  - **append, prepend, `link --into`**: `compose` loads the stored document with `loadDoc(rawContent, text)` and inserts the addition's blocks (`markdownToDoc`) after its blocks (append), after the title line when the first block is a heading or paragraph holding just that line (prepend), or before every block (`update --top`), then `buildNoteContent` derives every field; existing blocks survive exactly (the empty caret paragraph at the joining edge is dropped).
  - **`edit`**: block scoped; only top level blocks whose own markdown contains `--old` are serialized, edited, and parsed back, and only they are checked for losses; when the whole note holds more matches than its blocks do (a match spans blocks), the matches are counted on the whole note and the edit rewrites the whole document.
  - **`update --replace`**: a full rewrite, preceded by `rewriteLosses`, which compares the stored document with its markdown round trip.
  - **`duplicate --suffix`**: `duplicateContent` inserts the suffix as unmarked text into the line the title comes from (the first textblock with text, after the last non space character of its first line, before any hard break; at the start, without leading spaces, when that line is blank) and derives every field from the result, so the rest of the copy survives exactly.
    It needs a core that exports `duplicateContent` (Overnote protocol v3.0 or newer), the same rule Search Notes' Duplicate sends, and the content goes to the helper in the `notes.duplicate` call itself (section 6.13).
  - When an `edit` or `--replace` would lose anything, it fails with `LOSSY_REWRITE`, whose `losses` field names it (`unsupported-content`, `collapsed-toggle`, or `formatting`, such as blank line runs or implicit list numbers); `--allow-loss` writes anyway.
  On the 19 notes of a real database, append kept every block of every note, a whole note rewrite would have changed 6 of them, and a block scoped edit of a word was clean in 104 of 114 cases.
- **One snapshot per command.** Every command runs all of its reads inside one `reader.snapshot()`, a deferred read transaction, so counts, rows, and the current note come from the same WAL snapshot.
- **Schema check: columns, not versions.** On open the reader accepts any `PRAGMA user_version` of 1 or newer whose tables carry every column in `REQUIRED_COLUMNS` (`src/store/readonly-db.ts`, beside the queries), probed with `pragma_table_xinfo`, which also lists generated columns.
  The list holds every column a query selects, filters, or sorts on: all 13 `notes` columns of schema 1 (the summary columns, `title_fold` and `text_fold` for search, `TITLE_MATCH` and `findByTitle`, `markdown` for backlinks, `raw_content` and `caret_position` for `read`) and `settings.key` and `settings.value` for `currentNoteId`; a query that starts using a column adds it there.
  A missing column (or table) is `DATABASE_ERROR` whose `missing` field names each as `<table>.<column>`, and `user_version` 0 is refused as not an Overnote schema; no query runs in either case, and no SQLite message reaches the output.
  An exact version allowlist turned Overnote's additive schema 2 into a read outage until the CLI was rebuilt; Overnote's own read-only fallback checks no version either.
  `TESTED_SCHEMA_VERSION` (today 2) is the newest schema the tests cover: a newer one reads normally, and `status` and `home` say to update (sections 6.1 and 6.6).
  The update hint is one pasteable line from `updateHint(binPath)`: when the running script's package root (two levels above its real path) is a git checkout, which a linked `npm install -g .` runs from, it is `git -C <root> pull --ff-only && npm --prefix <root> run build`; for a copied install it rebuilds and reinstalls from the checkout.
  Schema 2 is purely additive (generated sort columns, paging indexes, and the `notes_fts` table), and every query names its columns, so the same queries run on both; search keeps the folded `LIKE` scan and does not use the FTS index.
- **Helper not running.** Writes fail with `HELPER_NOT_RUNNING` and the hint `overnote-axi open`, which starts Overnote through its Raycast deeplink.
  When the runtime dir or socket exists but fails the trust check of section 3.2, opening Overnote cannot help, so the code stays `HELPER_NOT_RUNNING` but the message says the socket was refused and the hint is `overnote-axi status`, which names the reason; `home` reports the same state as `refused` with the same hint.
  Reads keep working.

### 3.2 Paths

| Thing | Default | Override |
|---|---|---|
| Support dir | `~/Library/Application Support/com.raycast.macos/extensions/overnote` | `OVERNOTE_SUPPORT_DIR` |
| Database | `<support dir>/notes.sqlite` | follows the support dir |
| Runtime dir | `/tmp/overnote-<uid>` | `OVERNOTE_RUNTIME_DIR` |
| Socket | `<runtime dir>/helper.sock` | follows the runtime dir |

The variable names are the ones Overnote's own scripts and end to end tests use (architecture §9).
Before connecting, the CLI checks that the runtime dir is a real directory owned by the current user with no group or other permissions, mirroring `ensureRuntimeDir` in Overnote's `src/domain/paths.ts`; then it checks the socket itself with `lstat` (a socket, not a symlink, owned by the current user); otherwise it refuses with `HELPER_NOT_RUNNING` rather than talk to a socket another user could have planted.
A missing runtime dir or socket hints `overnote-axi open`; one that exists but fails a check hints `overnote-axi status` (section 3.1).
The CLI never creates the runtime dir or the database.

### 3.3 Bundling `@overnote/core`

- `scripts/link-overnote.mjs` maintains a git-ignored `.overnote` symlink to the Overnote checkout (`OVERNOTE_DIR`, else `../overnote`, else, inside a git worktree, the `overnote` folder next to the main checkout, found through `git rev-parse --git-common-dir`); npm runs it before `build`, `test`, and `typecheck`.
- `tsconfig.json` paths and `vitest.config.ts` aliases resolve `@overnote/core` and `@overnote/core/text` through that symlink, so types and tests use the real source.
- `scripts/build.mjs` runs esbuild with `splitting: true`: the entry `dist/overnote-axi.js` is a few hundred bytes, every command is its own chunk, and `src/markdown/convert.ts` (the only importer of the full core entry, reached only through a dynamic import) pulls Tiptap, ProseMirror, and markdown-it into one chunk of about 500 KB that read commands never load.
- Light helpers (`fold`, `displayTitle`) come from `@overnote/core/text`, which has no Tiptap import.
- The published package contains only `dist/`, the skill, `LICENSE`, and `README.md`; `dependencies` stays empty.
- The build refuses a core that does not export `duplicateContent` (`scripts/overnote-dir.mjs` reads `packages/core/src/index.ts` with comments removed and accepts a declared export, an `export { ... }` list, or an `export * from` a module that exports it (a `./x.js` specifier maps to `x.ts`), keeps regex literals intact while blanking comments, then says which Overnote checkout to update), so `src/markdown/convert.ts` imports it directly.
- The build records which core it bundled: `git rev-parse --short HEAD` of the Overnote checkout plus `-dirty` when `packages/core` has uncommitted changes, compiled into `src/build-info.ts` and shown by `status`.
  Outside `prepack`, a dirty core also prints one warning line that names the checkout and suggests `OVERNOTE_DIR`.
  `prepack` builds with `OVERNOTE_REQUIRE_CLEAN=1`, which refuses a dirty core unless `OVERNOTE_ALLOW_DIRTY=1`, and runs the skill check, so a stale or missing `dist/` cannot be packed.
- `bin/overnote-axi.ts` checks `process.versions.node` right after the version fast path: below 22.16 (`node:sqlite` needs a flag before 22.13 and FTS5 is missing before 22.16) it prints `error: overnote-axi needs Node 22.16 or newer (running <v>)` with `code: VALIDATION_ERROR` and exits 2, except the home view, which prints the same message as a degraded payload and exits 0 so a hook never breaks a session.

## 4. Output conventions

- stdout carries TOON only (src/output/toon.ts is a dependency free encoder for the TOON spec with the comma delimiter).
  Help text is plain text in the same `label[N]:` style.
- Note bodies are printed as an indented text block under `markdown:` (or `text:`), not as an escaped TOON string, because TOON has no block scalar and escaped markdown is unreadable.
- Timestamps in list rows are local dates (`2026-10-20`), which need no quoting; detail views add the raw `updatedAt` millisecond value, because that is the stale write token.
- Lists always start with `count: <shown> of <total> <noun>`.
  When more exist, a hint shows the next page.
- **Hints carry the current invocation forward.** Every hint that repeats the current command is rebuilt from the parsed flags of this call with only the changed flag replaced (`rebuildInvocation` in `src/args.ts`), for example `overnote-axi list --offset 50 --sort accessed --fields id,title,accessed`.
  Content flags are never carried into a hint, so a hint cannot repeat a write.
- **One unit for sizes.** Every count the CLI prints is in Unicode code points.
  `chars` (in `list`, `search`, and `read` metadata) is the code point count of the note's plain text, the number Overnote itself shows; a truncated body says what it measured: `... (truncated, showing 1200 of 2475 markdown chars)`.
- An empty result is one line that states the zero, such as `notes: 0 live notes`, and exits 0.
- Mutations print a short confirmation block and, where the next step is not obvious, `help[N]:` hints.
  A mutation that finds the desired state already in place prints the one no-op token `(no-op; <reason>)` and exits 0.
  Content write confirmations (`update`, `edit`, `link --into`) always include the note's `title`, and any write that changes the display title adds `warning: title changed from 'X' to 'Y'`, since `title:` references to the old title stop matching.
- Errors print `error:`, `code:`, optional detail fields, and `help[N]:` with the command that fixes the problem.
  Messages start with a lowercase word (a leading `--` would make TOON quote the line, so a flag error reads `flag --limit must be at most 50 (got 51)`), list valid values comma separated, and quote user input with single quotes, never escaped double quotes.
- An unknown command or flag, or a value outside a flag's or argument's choices, within edit distance 2 of a real one names it (`unknown command lsit (did you mean list?)`, `flag --agent does not accept claud (did you mean claude?)`), and the first hint is the corrected invocation: the argv as typed with only that token replaced (`closest` and `correctedInvocation` in `src/args.ts`).
  Content values in that hint become placeholders (`--content "<markdown>"`), so it cannot repeat a write.
- Nothing is ever written to stderr unless `OVERNOTE_AXI_DEBUG` is set.
- A closed stdout (`overnote-axi list | head -3`) is a normal end of output: EPIPE exits 0 with no stack trace (`guardStdout` in `src/cli.ts`).

### 4.1 Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success, including empty results and idempotent no-ops |
| 1 | The request was valid but could not be satisfied (any code except `VALIDATION_ERROR`) |
| 2 | Usage error (`VALIDATION_ERROR`): unknown command or flag, bad value, missing argument |

### 4.2 Error codes

| Code | When | Typical help |
|---|---|---|
| `VALIDATION_ERROR` | Bad usage, caught before any data access | the corrected usage line and `<command> --help` |
| `NOTE_NOT_FOUND` | No note matches the reference | `overnote-axi search "<text>"` |
| `AMBIGUOUS_NOTE` | A fragment or title matches several notes; the message gives the total (`matches 14 notes; showing 5`) and up to 5 candidates are listed | the failing command with `<id>`, such as `overnote-axi delete <id>` |
| `NOTE_TRASHED` | A content write targets a note in Recently Deleted | `overnote-axi recover <id>` |
| `NOT_PINNED` | `move` on an unpinned note | `overnote-axi pin <id>` |
| `STALE_WRITE` | The note changed after the caller read it; nothing was written; `updatedAt` holds the stored value | `overnote-axi read <id>` |
| `TEXT_NOT_FOUND` | `edit --old` text is not in the note | `overnote-axi read <id> --full` |
| `AMBIGUOUS_TEXT` | `edit --old` text occurs more than once; `matches` holds the count | add context to `--old`, or pass `--all` |
| `LOSSY_REWRITE` | `edit` or `update --replace` would lose stored content; `losses` names what | `overnote-axi update <id> --content ...` (append keeps everything), or repeat with `--allow-loss` |
| `OVERWRITTEN_BY_EDITOR` | The write landed, then the open editor saved over it within the verify window (the written blocks are gone; a merge that keeps them is not an error) | `overnote-axi read <id>`, then retry once the person stops typing |
| `HELPER_NOT_RUNNING` | The socket is missing or refuses the connection, or the runtime dir or socket fails the trust check | `overnote-axi open`; `overnote-axi status` when the trust check failed |
| `HELPER_TIMEOUT` | No answer within the protocol timeout (3 s); for `create` and `duplicate` the note may have landed | retry, then `overnote-axi status`; for `create` and `duplicate`, `overnote-axi list --sort created` before any retry |
| `OUTCOME_UNKNOWN` | The helper closed the connection after a write was sent, so it may or may not have landed (a drop during a read is `HELPER_NOT_RUNNING`) | `overnote-axi read <id>`, or `overnote-axi list --sort created` after `create` or `duplicate`, before any retry |
| `HELPER_ERROR` | Any other helper error, translated, never echoed raw | `overnote-axi status` |
| `DATABASE_NOT_FOUND` | No `notes.sqlite` at the resolved path | `overnote-axi open`, or set `OVERNOTE_SUPPORT_DIR` |
| `DATABASE_ERROR` | The database exists but cannot be read | `overnote-axi status` |
| `IO_ERROR` | A content file, hook config, or `open` failed | depends on the file |
| `UNKNOWN` | Anything unexpected; details only on stderr with `OVERNOTE_AXI_DEBUG=1` | `overnote-axi status`, and `OVERNOTE_AXI_DEBUG=1 overnote-axi <same args>` |

## 5. Note references

Every `<note>` argument accepts, in this order:

1. `current`: the note Overnote last showed (the `currentNoteId` settings row), falling back to the most recently updated live note.
2. A full 26 character ULID, case-insensitive.
3. `title:<text>`: the display title equals `<text>` after Overnote's fold (NFKD, marks removed, lowercased); live notes win over trashed ones.
4. A unique id prefix or suffix of at least 6 characters, case-insensitive.
   Suffixes are the ones to use: a ULID starts with its creation timestamp, so notes made minutes apart share a prefix, while the last characters are random.

ULIDs never contain `u`, so `current` cannot collide with an id.
Several matches produce `AMBIGUOUS_NOTE` with the total and the candidates as rows; zero produce `NOTE_NOT_FOUND`.
Messages quote the reference in single quotes; hints follow the failing command: an id shaped reference hints `overnote-axi list` (or `overnote-axi trash` for `recover`), and only an ambiguous fragment or a fragment under 6 characters recommends a suffix; a title hints `search` (with `--trash` for `recover`).
Reads resolve trashed notes too (and say `state: trashed`); content writes refuse them with `NOTE_TRASHED` and the one message `note '<title>' is in Recently Deleted` (`trashedError` in `src/store/refs.ts`).
The irreversible `delete --permanent` accepts only a full id (section 6.14).

## 6. Command surface

Flags always follow the command, `--help` works everywhere, and short flags do not exist.
The word `help` stands for `--help` alone (`overnote-axi help`), before a command (`overnote-axi help read`), and as the only argument of a command whose first argument cannot be `help` (`overnote-axi list help`, `overnote-axi setup help`); a note reference or a query may still be the word `help`.
The top-level help examples lead with `read current`, the safest first call.
`--` ends flag parsing.
Content flags are shared: `--content <markdown>`, `--content -` (read stdin; stdin is never read implicitly, so a hook or a harness with an open stdin can never hang), or `--content-file <path>`.
Exactly one may be given.

Examples below use shortened ids for readability; real output prints full 26 character ids.

### 6.1 `overnote-axi` / `home`

The default view and the session hook payload.
Flags: `--limit <n>` recent rows (default 5, 0 to 50), `--pinned-limit <n>` pinned rows (default 9, 0 to 9).
The session hook runs `home --limit 3 --pinned-limit 3`.

```
bin: ~/.npm-global/bin/overnote-axi
description: "Read, search, create, update, organize, and link Overnote notes with compact TOON output, no plugin and no server."
overnote:
  helper: running v0.5.0
  notes: 42 live
  pinned: 3
  trash: 5
current: 01JAB3K9QW Standup
pinned[3]{id,title,updated}:
  01JAB3K9QW,Standup,2026-10-20
  01JA7Q2M1C,Groceries,2026-10-18
  01J9ZT4E8D,Reading list,2026-09-30
recent[2]{id,title,updated}:
  01JAC0P5RT,Invoice draft,2026-10-19
  01JAB9V7XN,Trip ideas,2026-10-17
help[4]:
  overnote-axi read <id>
  overnote-axi search "<text>"
  overnote-axi create --content "<markdown>"
  overnote-axi list (all 42 live notes)
```

- Helper states: `running v<version>`; `stopped (reads work; writes need overnote-axi open)`; `refused (its runtime dir or socket is not private to you; overnote-axi status says why)` when the runtime dir or socket exists but fails the trust check (section 3.2, the case where a write hints `status`); or `not answering (overnote-axi status)` when the socket accepts but stays silent.
  The probe only says `stopped`; `helperView` in `home.ts` tells `refused` apart with the same checks as the writer.
  When the helper cannot take writes, its fix leads the hints (`overnote-axi open` for stopped, `overnote-axi status` otherwise), so an agent does not try a write first.
  The probe (`context.probeHelper()`) has one 400 ms budget for connect plus ping (`PROBE_TIMEOUT_MS`) and never throws, so a hung helper cannot stall a session start.
- No database: `overnote: no notes database yet` plus the `overnote-axi open` hint, exit 0 (the hook must never fail a session).
- A database that exists but cannot be read (a schema without a column the reader needs, a file that is not an Overnote database) is reported the same way: the `overnote` block holds the error's `error`, `code`, and detail fields, its hints follow, and the exit code is still 0.
- A schema newer than `TESTED_SCHEMA_VERSION` that keeps every required column reads normally and adds one line to the `overnote` block, `schema: "<n>, newer than this overnote-axi was tested with (overnote-axi status)"`, so the session hook payload stays within its 24 lines and `status` carries the update command.
- No notes: `notes: 0 live` and only the `create` hint, after the helper's fix when it cannot take writes.
- `current` resolves like the `current` reference (section 5) and prints on one line, `current: <id> <title>`; when no live note is open in Overnote it is the newest live note and the line ends in `(newest; none open)`.
- A block whose limit is 0 is left out.
- Pinned rows are capped by `--pinned-limit` (at most 9, the app's ⌘1 to ⌘9) and recent rows exclude pinned notes.
  When pinned rows are cut, `overnote-axi list --pinned (all <n> pinned notes)` names the rest; when recent rows are cut (including a limit of 0), `overnote-axi list (all <n> live notes)` does.
- The `help` lines come from `HOME_HINTS` in `src/guidance.ts`, the same block the skill renders (section 9).

### 6.2 `list`

Live notes in the app's order: pinned first in pin order, then by the sort column descending, then id.
Flags: `--limit <n>` (50), `--offset <n>` (0), `--pinned`, `--sort updated|accessed|created` (updated), `--fields <a,b>` from `id,title,updated,created,accessed,chars,pinned,preview` (default `id,title,updated`; `deleted` is a `trash` column).

```
count: 50 of 143 live notes
notes[50]{id,title,updated}:
  01JAB3K9QW,Standup,2026-10-20
  ...
help[2]:
  overnote-axi list --offset 50
  overnote-axi read <id>
```

- The paging hint keeps every other flag of the call (`list --pinned --fields id,title,pinned --offset 50`).
- `pinned` is the 1 based pin position or empty; `chars` is the code point count of the text (architecture §5 `charCount`); `preview` is the first 100 characters of text after the title line, on one line, so it never repeats the title.
- Empty: `notes: 0 live notes` with a `create` hint, or `notes: 0 pinned notes` with `pin <id>` and `list` hints.
- An `--offset` past the end prints `count: 0 of <total> live notes (offset <n> is past the end)` and a hint for the first page.
- Pin positions come from the pinned list itself (the stored `pinned` value is a sort key such as 1000 or 2000.5), so they stay 1 to N.

### 6.3 `search <query>`

The app's matching: folded substring on title or text (architecture §5 fold rule), title matches first, then pinned, then most recently updated.
Flags: `--limit <n>` (20), `--trash`, `--fields` from `id,title,match,updated,chars,pinned` (default `id,title,match`).

```
count: 2 of 2 notes matching 'standup'
hits[2]{id,title,match}:
  01JAB3K9QW,Standup,title
  01JAC0P5RT,Weekly sync,"...moved the standup to 9:30 so Sam can..."
help[1]:
  overnote-axi read <id>
```

- `match` is `title` for title hits, else about 80 characters of text around the first match on one line, with `...` on each side where the text goes on.
- When hits were cut, a hint repeats the call with `--limit` raised to the total (at most 200); `--trash` hits add a `recover <id>` hint.
- Empty: `hits: 0 notes match 'standup'` with `search --trash` and `create` hints; the `--trash` hint keeps the other flags of the call.
- The query is shown in single quotes, so the line needs no TOON escaping unless the query itself holds a comma, a colon, or a double quote; a query with an apostrophe is shown in double quotes instead, which TOON escapes, so it still reads unambiguously.
- A blank query is a usage error.

### 6.4 `read <note>...`

Flags: `--full`, `--meta` (no body), `--format markdown|text` (markdown).

```
note:
  id: 01JAB3K9QW
  title: Standup
  state: live
  pinned: 1
  updated: "2026-10-20 09:12"
  updatedAt: 1792543271491
  created: 2026-09-02
  chars: 2310
  links: "2 out, 1 in"
markdown:
  # Standup
  - [ ] demo the CLI
  ...
  ... (truncated, showing 1200 of 2475 markdown chars)
help[1]:
  overnote-axi read 01JAB3K9QW --full
```

- Bodies truncate at 1200 code points of markdown unless `--full`, cut at the last line break or else the last space in the final quarter of that window, so a body never ends mid word; the hint appears only when truncated.
- `chars` is the plain text count (section 4); the truncation line counts markdown, and says so.
- Several references print `count: <n> notes` first, then one `note:` block per note, in order.
  When any body was truncated, one hint follows, listing only the truncated ids: `overnote-axi read <id> <id> --full`.
- A trashed note shows `state: trashed` and `deleted: <date>`.
- An empty note (or one of only blank lines) prints `markdown: (empty)`.
- A reference given twice prints once; if any reference fails to resolve, the command fails and prints no note.
- `--format text` prints the plain text under `text:`, and its truncation line counts `text chars`.

### 6.5 `links <note>`

```
note: 01JAB3K9QW Standup
outgoing[1]{id,title}:
  01JA7Q2M1C,Groceries
backlinks[1]{id,title}:
  01JAC0P5RT,Weekly sync
```

- Outgoing links are Overnote deeplinks found in the markdown (`raycast://extensions/wesleybldc/overnote/toggle-notes?context=...`); a link to a missing note shows `title: (missing)`.
- Backlinks are live notes whose markdown links to this note.
  A LIKE prefilter (`%toggle-notes?context=%<id>%`, with `%`, `_` and `\` escaped) narrows the candidates; it is a table scan, since no index helps a leading wildcard.
  Each candidate is then confirmed with `extractNoteLinks`, which decodes the context, so a percent encoded link and a hand pasted raw `{"id":...}` both count and a mere mention of the id does not.
- Empty sides print `outgoing: 0 links` and `backlinks: 0 notes link here`; with no links at all, the hint is `overnote-axi link <id> --into <other note>`.
- A trashed note resolves too and adds `state: trashed` under `note:`.

### 6.6 `status`

```
helper:
  state: running
  version: 0.5.0
  pid: 4242
database:
  path: ~/Library/Application Support/com.raycast.macos/extensions/overnote/notes.sqlite
  schema: 2
  notes: 42 live
  trash: 5
socket: /tmp/overnote-501/helper.sock
backups:
  count: 10
  latest: 2026-10-20
```

- `backups` comes from `system.status` and is omitted while the helper is stopped; `latest: none` means no backup yet, and a `restore:` line appears only while the helper offers to restore one.
- A `build` block shows the CLI version and the Overnote commit its core came from (`core: 4784d66`, or `4784d66-dirty`).
- It is a diagnostic, so it always exits 0 and reports each problem as fields plus the hint that fixes it:
  - the helper is asked once, over the writer's single connection (`system.status`); `HELPER_NOT_RUNNING` shows `state: stopped` with a `reason` (no runtime dir, runtime dir refused, no socket, socket refused), `HELPER_TIMEOUT` shows `state: not answering`, and any other code shows `state: error` with it;
  - a missing database shows `state: missing`, and an unreadable one shows `state: unreadable` with the error's fields (`schema` and `missing` when it lacks a required column);
  - a schema newer than `TESTED_SCHEMA_VERSION` that still reads keeps `schema: <n>`, adds `note: "newer than <tested>, the newest this overnote-axi was tested with; reads work, but update it"`, and hints the update command of section 3.1.

### 6.7 `open [note]`

Opens the Overnote panel on a note (`toggle-notes` deeplink with `{ id }`) or on the last note (`open-notes` deeplink) by running `/usr/bin/open <url>` without a shell.
This also starts the helper, which is why write errors point here.
Output: `opened: 01JAB3K9QW Standup` or `opened: Overnote`.
A note in Recently Deleted is refused with `NOTE_TRASHED` (recover it first); without a note, no database is needed.
`OVERNOTE_AXI_OPEN_CMD`, honored only when set, replaces `/usr/bin/open` with another absolute path; the test suite sets it so no test can launch the real Overnote (section 11).

### 6.8 `create`

Flags: content flags, `--title <text>` (prepends `# <text>` and a blank line), `--pin`, `--open` (sends `show: true`).
At least one of `--title` or content is required; an empty note and a blank or multi line `--title` are usage errors.

```
created:
  id: 01JAD1X2YZ
  title: Standup
  updatedAt: 1792543271491
help[2]:
  overnote-axi read 01JAD1X2YZ
  overnote-axi update 01JAD1X2YZ --content "<markdown>"
```

- Not idempotent by design: creating twice makes two notes.
  So a failed `--pin` names the created note (`id` field, `overnote-axi pin <id>` hint), and a timeout or dropped connection says the note may have landed and hints `overnote-axi list --sort created`.
- With `--pin`, `pinned` is the note's 1 based place in the pinned list, read back after the pin (`?` when it cannot be found).
- `current` keeps naming the note it named, unless `--open`: helpers before Overnote's fix persist every created or duplicated note as current, so the CLI reads `currentNoteId` before the write and, when the helper moved it to the new note, puts it back with `notes.setCurrentNote` (a failed restore is a `warning`, not an error).

### 6.9 `update <note>`

Modes: `--append` (default), `--prepend`, `--top`, `--replace`; giving more than one is a usage error.
Content is required.

- Append adds the addition's blocks after the stored document's blocks; prepend adds them right after the title line when the note starts with one (a heading or paragraph holding just that line), so the title and every `title:` reference stay; `--top` adds them above everything, title included (`converter.compose`, section 3.1).
  Every existing block, including content markdown cannot express, is kept exactly.
- Append is a no-op when the trimmed stored markdown already ends with the trimmed addition after normalization (`converter.normalize`, so `* item` matches the stored `- item`); prepend when the markdown below the title line already starts with it, and `--top` when the note does (exit 0, `(no-op; <reason>)`).
- `--replace` runs `rewriteLosses` first and fails with `LOSSY_REWRITE` when the stored note holds content its markdown cannot carry, unless `--allow-loss`.
- `--replace` requires `--expected-updated-at <ms>` (the `updatedAt` an earlier `read` showed); without it, it is a usage error that suggests `overnote-axi read <note> --meta`.
- With or without the flag, the CLI reads the note through the helper, checks `--expected-updated-at` if given, composes, converts with core, and sends `notes.update` with `expectedUpdatedAt` set to the value it just read.
  Either mismatch fails with `STALE_WRITE` and writes nothing.
- When the target is the note open in Overnote, the output adds `warning:` and the write is verified (section 7).

```
updated:
  id: 01JAB3K9QW
  title: Standup
  mode: append
  chars: 2342
  updatedAt: 1792543300000
```

### 6.10 `edit <note>`

Exact text replacement on the markdown, the primitive for checking a task or fixing a line without rewriting the note.
Flags: `--old <text>` (required, non-empty), `--new <text>` (required, may be empty with `--new=`), `--all`, `--expected-updated-at <ms>`, `--allow-loss`.

- Zero matches: `TEXT_NOT_FOUND`; several without `--all`: `AMBIGUOUS_TEXT` with `matches: <n>`.
- A retry of a whole line edit is a no-op (`alreadyEdited` in `src/markdown/compose.ts`), such as a repeated task check off or As of line refresh.
  It applies only when all of these hold: `--all` is not set; `--new` after normalizing and trimming is not blank; `--old` occurs 0 times; the lines of `--new` equal a contiguous run of whole lines of the stored markdown exactly once (trailing whitespace ignored); and the raw text of `--new` occurs exactly once.
  The result is then `(no-op; already applied since --old is gone and --new is there once as whole lines)` with exit 0; anything else is `TEXT_NOT_FOUND`, so `--new Sam` inside `- [ ] call Sam` is not taken as applied, and a deletion (`--new=`) still reports `TEXT_NOT_FOUND`.
- `--old` equal to `--new` runs every check first (fresh read, `--expected-updated-at`, presence, ambiguity) and then writes nothing.
- Only the top level blocks that contain the match are rewritten (`converter.edit`, section 3.1); the rest of the note is untouched.
  A match that spans blocks rewrites the whole note.
- If the rewritten blocks (or the note) lose content, the edit fails with `LOSSY_REWRITE` unless `--allow-loss`.

```
edited:
  id: 01JAB3K9QW
  title: Standup
  replaced: 1
  updatedAt: 1792543300000
```

### 6.11 `link <note>`

Without `--into`, prints the note's markdown link, which carries the deeplink once, and writes nothing:

```
link:
  id: 01JA7Q2M1C
  markdown: "[Groceries](raycast://extensions/wesleybldc/overnote/toggle-notes?context=%7B%22id%22%3A%2201JA7Q2M1C%22%7D)"
```

With `--into <target>`, appends (or with `--prepend`, inserts below the title line like `update --prepend`) `[<label>](<url>)` to the target as its own paragraph, through the same document level path as `update` (`writeContent` plus `converter.compose`); the confirmation names the target's `title`.
`--text <label>` overrides the label (default: the linked note's display title, with `[`, `]`, and `\` escaped).
Linking a note into itself is a usage error; inserting a link the target already ends with is a no-op.

### 6.12 `pin`, `unpin`, `move <note> up|down`

- `pin` appends to the end of the pinned list (`notes.pin`); an already pinned note is a no-op.
- `unpin` is a no-op on an unpinned note.
- `move` swaps with the neighbor pin `--steps <n>` times (default 1) via `notes.movePinnedUp` or `notes.movePinnedDown`; at either end it stops and reports the position it reached; an unpinned note is `NOT_PINNED`.
- Trashed notes cannot be pinned (`NOTE_TRASHED`).

```
pinned: 01JAB3K9QW Standup (position 4 of 4)
```

### 6.13 `duplicate <note>`

One `notes.duplicate` call makes the copy; prints the new note like `create`, and like `create` (without `--open`) keeps `current` on the note it named.

- Without `--suffix` (or with an empty one) it sends `notes.duplicate { id }`, an exact copy, on every helper version.
- With `--suffix <text>` it builds the copy's content with `converter.duplicateContent` (section 3.1) from the source as the fresh `notes.get` returned it, and sends it in the same call, `notes.duplicate { id } & NoteContent`, which the helper stores verbatim (architecture §5), as Search Notes' Duplicate does.
  No copy ever exists without its suffix, and no `notes.update` follows.
  The confirmation shows the suffixed title.
- Content on `notes.duplicate` needs helper 0.5.0 (protocol v3.0) or newer, and how older helpers treat it is undocumented, so `--suffix` first reads the version from `system.ping`.
  An older or unparsable version fails before any write with `HELPER_ERROR`, a message naming 0.5.0 and the running version and saying to update Overnote, the hint `overnote-axi open`, and `overnote-axi duplicate <id>` for an exact copy.
- The CLI never sends `titleSuffix`: helpers before protocol v3.0 stored it in the title only, so the copy's first line kept the old title and its next save dropped the suffix, and v3.0 refuses it with `-32602`.

### 6.14 `delete <note>`

- Default: `notes.delete`, a soft delete into Recently Deleted (the pin is cleared; the app purges after 60 days).
  A note already in the trash is a no-op.
- `--permanent` accepts only a full 26 character id; a fragment or `title:` reference is a usage error whose message names the resolved full id (its hint is `read <id> --meta`, never the erase itself), and `current` is refused, because the irreversible path must never act on a guess or a fallback.
  If the note is live it is trashed first; then the CLI re-reads it with `notes.get`, confirms `deletedAt` is set, and calls `notes.permanentlyDelete`.
  The writer maps the protocol 404 to `NOTE_NOT_FOUND` like everywhere else; `delete` itself turns a 404 from `notes.get` into `(no-op; no note with this id exists)` and one from `notes.permanentlyDelete` into `(no-op; already erased)`.
  After the erase it reads the note once more: the helper silently skips a note that left Recently Deleted in between, so a note that still exists is a `HELPER_ERROR`, never a reported erase.

```
deleted: 01JAB3K9QW Standup (in Recently Deleted)
help[1]:
  overnote-axi recover 01JAB3K9QW
```

### 6.15 `recover <note>`

`notes.recover`; a live note is a no-op.
Recovered notes come back unpinned, as in the app.

### 6.16 `trash`

Lists Recently Deleted from SQLite, most recently deleted first.
Flags: `--limit` (50), `--offset`, `--fields` (default `id,title,deleted`), `--empty`, `--permanent`, `--expected-count <n>`.

```
count: 5 of 5 notes in Recently Deleted
trash[5]{id,title,deleted}:
  01JA2B3C4D,Old draft,2026-10-12
  ...
help[1]:
  overnote-axi recover <id>
```

- No hint anywhere offers a `--permanent` command: erasing is typed only on the user's explicit request (section 7).
- `--empty` without `--permanent` is a usage error that explains what `--permanent` would erase (with the count) and hints `overnote-axi trash`.
- `--empty --permanent` calls `notes.emptyTrash` and prints `emptied: 5 notes erased`; an empty trash is a no-op.
- One window stays open: `notes.emptyTrash` takes no expected count, so a note trashed between the count check and the helper call is erased too; the CLI compares the erased count with the one it checked and says so in the output when they differ (section 7).
- `--expected-count <n>` makes it refuse (`STALE_WRITE`, with the current count) unless Recently Deleted still holds exactly `n` notes, so notes trashed after the agent looked are not erased unseen; on a mismatch the only hint is `overnote-axi trash`, so the agent looks again instead of retrying with the new count.
- The paging hint keeps `--fields` and `--limit`.
- Empty listing: `trash: 0 notes in Recently Deleted`.
- An `--offset` past the end says so like `list`: `count: 0 of 5 notes in Recently Deleted (offset 40 is past the end)`, with a hint back to the first page.

### 6.17 `setup [hooks|skill]`

See section 8.

## 7. Safety model for writes

- **Single writer.** The CLI has no SQLite write path at all; the reader opens read-only and sets `query_only`.
- **Stale write guard.** Every content write sends `expectedUpdatedAt`, so the helper refuses it when the note changed between the CLI's read and its write (architecture §5 `notes.update` conflict result).
  `--expected-updated-at` extends that window back to the agent's own earlier `read`, and `--replace` requires it, because replacing a note the person edited meanwhile would silently destroy their work.
- **The guard does not cover unsaved typing, so the open note is verified.** The open editor keeps its own unsaved edits, and what it does when a socket write lands depends on the Overnote version (Overnote `editor/src/session/session.ts`, `saveContent`, `rebase` and `refresh`).
  - Before Overnote protocol v2.14 the editor's local edit wins: on a conflict it retries with the stored `updatedAt`, so if the person is typing in the same note, or has a 300 ms debounced save pending, the CLI's write succeeds and the editor's next save then overwrites it.
  - From v2.14 (Overnote commit `8c287b5`) the editor never overwrites an outside change: it merges the stored version into its unsaved edits by top level block with core's `mergeDocs`, and where both sides changed the same block it keeps both versions, its own first.
    No protocol change was needed, because the helper already sends `notes.changed` for every socket write.
  - Overnote `helper/VERSION` 0.4.0 marks the merging editor (`status` and `home` print it); the CLI still keeps its check unconditionally, because the helper does not report the protocol version and one check covers every install.
  - When the target is the note open in Overnote (what `current` resolves to), the output carries `warning: note is open in Overnote; unsaved edits there can win over this write`, which stays true for older editors.
  - For that note only, `writeContent` waits `VERIFY_DELAY_MS` (400 ms, past the autosave debounce) and re-reads it with `notes.get`.
    When `updatedAt` moved, `MarkdownConverter.writeSurvived` checks that every top level block the write added is still stored and every block it removed is still gone (empty caret paragraphs ignored); if not, the command fails with `OVERWRITTEN_BY_EDITOR`.
    A merging editor keeps those blocks, so its save passes the check, and the output's `updatedAt` is the newest stored value; an older editor's overwrite fails it.
    Writes to any other note skip the wait.
  - The check stays on v2.14 (helper 0.4.0 and later) too: it is the only signal on older Overnote installs, and it costs one `notes.get` after the wait.
- **Shared write flow.** `update`, `edit`, and `link --into` all run `writeContent` (`src/commands/write-flow.ts`): resolve, fresh `notes.get`, `deletedAt` check, `--expected-updated-at` check, plan, loss check, `notes.update` with `expectedUpdatedAt`, then the open note warning and verify.
  The organize commands (`pin`, `unpin`, `move`, `duplicate`, `recover`) resolve from SQLite and then decide on the note as `notes.get` returns it (`resolveFresh` in `src/commands/note-ops.ts`).
- **Idempotent mutations.** Pin, unpin, delete, recover, append, prepend, link, and a repeated `edit` report no-ops instead of errors, so retries are safe.
- **One call per new note.** `create` and `duplicate` each make their note in one helper call carrying its final content (`duplicate --suffix` sends it with `notes.duplicate`, section 6.13), so no half made note needs a recovery path and a timeout means only "look before retrying".
- **`current` stays put.** `create` and `duplicate` restore the previous current note when an older helper moved it to the new note (section 6.8), so `update current` never lands in the agent's own note while the panel shows another.
- **What `--permanent` unlocks.** Only two operations erase data irreversibly: `delete --permanent` and `trash --empty --permanent`.
  Neither has a default, a prompt, or an environment variable that enables it; the flag must be on the command line.
  `delete --permanent` takes only a full id and confirms `deletedAt` through the helper first; `trash --empty --permanent` takes `--expected-count` to pin what the agent saw.
  The residual race of `trash --empty`: the count is checked in SQLite and `notes.emptyTrash` takes no expected count, so a note trashed in the milliseconds between the two is erased unseen; the output reports any difference between the erased and the checked count, and closing the window needs an expected count in the helper.
  Everything else is recoverable from Recently Deleted for 60 days, and the helper's daily backups cover the rest.
- **No bulk deletes** besides emptying the trash: `notes.deleteAll` is deliberately not exposed.
- **Trusted socket only.** The runtime dir ownership and mode check and the socket `lstat` check of section 3.2 run before every connection.

## 8. Ambient context: `setup`

`overnote-axi setup` (same as `setup hooks`) installs a SessionStart hook so each agent session begins with the `home` view; `setup skill` installs the Agent Skill; `--uninstall` removes either; `--agent claude,codex,opencode` narrows the targets (default: every agent whose config directory exists).

| Agent | File | Entry |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `hooks.SessionStart[]`: `{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> home --limit 3 --pinned-limit 3", "timeout": 10 }] }` |
| Codex | `$CODEX_HOME/hooks.json` and `$CODEX_HOME/config.toml` (default `~/.codex`) | SessionStart command entry with the same `timeout`, plus `hooks = true` under `[features]` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/plugins/overnote-axi.js` (default `~/.config`) | a managed plugin that injects the same output as system context |

- **Command resolution** (`hookCommand`). The hook runs the bare `overnote-axi` when `PATH` resolves that name to the same real file as the running script.
  Otherwise it runs `"<node>" "<realpath of dist/overnote-axi.js>"`, both absolute and quoted, so the hook never falls back to an older `node` on the agent's `PATH`.
  `<node>` is the `node` found on `PATH` when its realpath equals the realpath of `process.execPath` (for example `/opt/homebrew/bin/node` for a versioned Homebrew Cellar path that the next `brew upgrade` deletes), and `process.execPath` otherwise; a different `node` on `PATH` is never used.
- **No dev hooks.** `setup` refuses with `VALIDATION_ERROR` when the running script ends in `.ts` or is not `dist/overnote-axi.js` (or an installed bin that resolves to it), so a run under tsx or vitest can never register a hook that points at source.
- **Idempotent and self repairing.** An entry is ours when its command runs this CLI's home view: the program is the bare `overnote-axi`, a path ending in `/overnote-axi`, or the quoted `dist/overnote-axi.js` script, followed by `home --limit 3 --pinned-limit 3` or a bare `home` from an older install.
  A user's own command that merely mentions the name (such as `cd ~/code/overnote-axi && npm test`) is never rewritten or removed.
  A repeat install with the same command and timeout changes nothing (`unchanged`); a moved binary or a different timeout is rewritten in place (`updated`).
- **Non-destructive.** JSON files are parsed and rewritten with only the hook entry changed, other keys and hooks kept in order; a file that does not parse is left alone and reported as `IO_ERROR`.
  Codex `config.toml` is edited line by line with no TOML parser: `hooks = true` is added under an existing `[features]` table (or the table is appended), and no other line is rewritten.
  The OpenCode plugin starts with a managed marker comment; a file at that path without the marker is never overwritten or removed: install reports `IO_ERROR` for that agent only, and uninstall reports it `skipped` with the reason `not written by setup, so it is left alone`, since nothing of ours is there and a retry could only fail the same way.
  The plugin runs the home view once per OpenCode session and adds nothing to a call without a session id (OpenCode also runs the transform for agent generations outside a chat).
  Every write is atomic (temp file in the same directory, then rename) and keeps the file mode.
  Codex's two files are a pair: both are planned before either is written, then `hooks.json` is written, then `config.toml`; if the `config.toml` write fails, `hooks.json` is restored (or removed, when setup created it), so the row is `error` and neither file changed.
- **Per agent results.** Each agent gets its own row and change (`installed`, `updated`, `unchanged`, `removed`, `absent`, `skipped` with a `reason`, or `error` with its code and reason), so a partial failure is visible and the others still apply; the exit code is 1 when any row is `error`.
- **Uninstall** removes only our entries (and the managed plugin), deletes a `SessionStart` array and then a `hooks` object it left empty, deletes a JSON file left holding only `{}` (a symlinked one is written as `{}` instead, so a dotfiles link survives), removes the OpenCode `plugins` directory and the `~/.claude/skills` directory when it emptied them, and reports `removed`, `absent`, or `skipped`.
  It leaves `[features] hooks = true` in Codex `config.toml`, because other tools rely on it.
- **Codex hook trust.** Codex runs a new or modified hook only after the user reviews and trusts it in its `/hooks` view, so when the codex row is `installed` or `updated`, setup adds a hint to open Codex, run `/hooks`, and trust the `overnote-axi` hook.
  Setup never writes Codex trust state and never uses `--dangerously-bypass-hook-trust`.
- **Explicit opt in.** Only `setup` writes agent configuration; no other command does, and no lifecycle hook writes notes (section 2).
- **Global, not directory scoped.** Notes have no project link, so the payload is the same in every directory and only user level config is written (section 2).
- **Hook cost.** `home --limit 3 --pinned-limit 3` is the whole payload: at most 24 lines (bin, description, five `overnote` lines, one `current` line, three pinned and three recent rows with their headers, and at most six hints with their header), enforced by a test on a fixture with 9 pins and 20 other notes.
  It exits 0 even when Overnote has no database, its helper is stopped or not answering, or Node is too old.
- **Locations come from the Context.** The integrations read `HOME`, `CODEX_HOME`, and `XDG_CONFIG_HOME` from `context.env` and `context.home`, never from `os.homedir()` directly, which is what lets the test suite isolate them (section 11).

Output:

```
setup:
  target: hooks
results[2]{agent,file,change}:
  claude,~/.claude/settings.json,installed
  codex,~/.codex/hooks.json,unchanged
```

## 9. Skill

- `skills/overnote-axi/SKILL.md` is generated by `scripts/build-skill.mjs` from `buildSkill()` in `src/integrations/skill.ts`.
  Its body is the home view with live state stripped: the static guidance in `src/guidance.ts` (`HOME_HINTS` shared with the home view, `NOTE_REF_HELP` shared with the top-level help, `WORKFLOW`, `SAFETY`, and `FORMATTING`) plus the top-level help's command list, so it cannot drift.
  `npm run check` and `prepack` run it with `--check`, which fails on a stale file.
- Frontmatter: `name: overnote-axi` and a trigger shaped `description` naming the intents (Overnote, Raycast notes, scratchpad, quick note, read, search, append, check off a task, pin, link, delete).
  It stays user invocable, so `/overnote-axi` loads it explicitly.
- The body says each thing once, with every command in backticks.
  **Start here** tells the agent to run `overnote-axi` first, lists the home hints, then the `WORKFLOW` steps (`update` and its prepend caveat: `--prepend` goes after the title line, `--top` above it; idempotent `edit`; `--expected-updated-at`; `link`).
  **Commands** holds the command list, the note reference rule (`current` falls back to the newest note; prefer id suffixes, since ULID prefixes are shared timestamps), and the exit codes.
  **Writing clean notes** is the `FORMATTING` list, the agent facing copy of the rules in Overnote's README section of the same name (linked from the skill): title first line, an `As of <Mon DD>.` line refreshed with `edit`, `##` sections, one blank line between blocks, short bullets, no tables or images, and dated sections appended at the end.
  It opens by scoping those rules to notes the agent creates and maintains: in a note the person wrote, the agent follows the existing layout.
  **Safety rules** is the single `SAFETY` list: append by default, block scoped `edit`, `--replace` and `delete` only on request, the 60 day Recently Deleted window, `--permanent` only on an explicit request (no hint ever offers it), the open note warning, and no direct database access.
  Besides the generated parts, `skill.ts` holds three hand written sections, each covered by `test/unit/skill.test.ts`:
  - **Examples**: runnable invocations, each checked against a real command and the flags it declares.
  - **Supported markdown**: the subset the Overnote editor stores, including what is lost (tables, images, HTML, toggle lists) and how deep to indent a nested item.
  - **Common errors**: the codes an agent most often meets and what to do, typed against `ErrorCode` so a renamed code fails typecheck.
- **Invocation rule.** A skill can be present while the binary is not on `PATH`, so the committed `SKILL.md` uses the bare `overnote-axi` and tells the agent: if `command -v overnote-axi` fails, run `npm install -g .` in this repository, or use `node <repo>/dist/overnote-axi.js`.
  `setup skill` writes its installed copy with the command `hookCommand()` resolves, so a skill installed by setup always runs.
  That copy states the resolved command exactly once, near the top, as what `overnote-axi` stands for; every other line, the examples included, keeps the bare name, so a long node plus script path is never repeated.
  No `npx` form of this CLI may appear until the npm name is published and owned (section 2); a unit test checks the committed file and the generated skill for it.
- Install paths: `overnote-axi setup skill` installs for Claude Code only (`~/.claude/skills/overnote-axi/SKILL.md`; `--agent` other than `claude` is a usage error for `skill`).
  Other agents use `npx skills add WesleyBLDC/overnote-axi --skill overnote-axi` once the repository is public; that runs the skills installer, not this CLI.
- The README presents the hook and the skill as two ways to get the same result; a user needs only one.

## 10. Performance budget

Measured on the built `dist/` with Node 22 or later, relative to the `node -e 0` floor on the same machine so the tests stay stable across hardware.

| Path | Budget |
|---|---|
| `--version`, `-v`, `-V` | floor + 10 ms (static imports: only `src/version.ts`) |
| `--help`, `<command> --help` | floor + 20 ms |
| `home`, `list`, `search`, `read` on 1,000 notes | floor + 40 ms |
| A content write (`create`, `update`, `edit`) | floor + 150 ms, including the core chunk and one helper round trip |
| Organize writes (`pin`, `delete`, ...) | floor + 60 ms (no core chunk) |

- The entry imports nothing but the version; `src/cli.ts`, each command, the runtime wiring, and the core chunk are dynamic imports.
- `node:sqlite` is loaded through `process.getBuiltinModule` on first use with its ExperimentalWarning muted.
- One SQLite connection and at most one socket connection per process; both are closed before exit, and the socket is unref'd while idle.
- The home view's helper probe has a 400 ms budget; an e2e test with a socket that accepts and never replies checks that `home` still finishes within floor + 600 ms.
- Content writes to the note open in Overnote add the 400 ms verify wait of section 7; writes to other notes do not.
- Search uses the folded columns the helper maintains, never a full table scan in JavaScript; backlinks are the one SQL table scan (section 6.5).

## 11. Testing strategy

- **Never real notes, never real agent config.** Before any test runs, `test/setup.ts` points `OVERNOTE_SUPPORT_DIR`, `OVERNOTE_RUNTIME_DIR`, and `OVERNOTE_BACKUP_DIR` at nonexistent temp paths, and `HOME`, `XDG_CONFIG_HOME`, and `CODEX_HOME` at an empty temp home, then asserts that none of them lies under the real home (`os.userInfo().homedir`) or `/tmp/overnote-<uid>`; it removes that temp root after each test file, so a run leaves nothing in `$TMPDIR`.
  Fixtures pass every path they hand to the CLI through the same `assertIsolated()` (`test/fixtures/guard.ts`).
- **Never the real app.** `test/setup.ts` sets `OVERNOTE_AXI_OPEN_CMD=/usr/bin/true`, so no test, and no CLI process a test spawns, runs `/usr/bin/open` with a `raycast://` URL, which would launch the real Overnote helper against the real database.
- **Shared fakes.** `test/fixtures/fakes.ts` provides `FakeReader`, `FakeWriter`, and `fakeContext()` over one in-memory store, faithful to architecture §5 including conflicts, 404 and 409 errors, and an `afterUpdate` hook that simulates the open editor saving over a write.
- **Unit** (`test/unit/`): TOON encoder against spec cases, argument parsing, rendering, the registry contract (every command loads a documented spec), note reference parsing, markdown composition, deeplink parsing, hook JSON merging on a temp `HOME`, skill generation.
- **Read path** (`test/store/`): a fixture builder creates `notes.sqlite` with the schema of architecture §6 (version 1 or 2, the latter with `notes_fts` and its triggers) in a temp support dir, so ordering, folding, paging, counts, and backlinks are checked without the helper.
  A higher `userVersion` on those tables, or a dropped column or table, covers the schema check of section 3.1.
- **Commands** (`test/commands/`): each command runs through `main()` with `fakeContext()`, asserting exact TOON output, empty states, hints (including carried forward flags), error codes, and exit codes.
- **Integration** (`test/integration/`): `test/fixtures/temp-helper.ts` starts the real `OvernoteHelper` (`OVERNOTE_HELPER_BIN`, default `<overnote>/helper/.build/release/OvernoteHelper`) with `--support-dir`, `--socket`, `--pid-file`, `--editor-dir` all in a fresh short `/tmp/onx-*` dir, `--headless`, and `OVERNOTE_BACKUP_DIR` in the same dir, then drives the CLI end to end: create, read back from SQLite, update with and without a conflict, edit, link, pin and move, delete, recover, empty trash.
  When the binary is missing the suite skips with a clear message.
- **Built binary** (`test/e2e/`): spawns `dist/overnote-axi.js` for `--version`, help, a read, and a write against the temp helper, `list` piped into a reader that closes early (exit 0, empty stderr), `home` against a socket that never answers, and the hook payload line count, and checks the timing budget against the `node -e 0` floor.
  The harness (`test/e2e/binary.ts`) builds a private copy with `scripts/build.mjs --outdir <tmp>/dist`, so a concurrent `npm run build` never swaps the bundle under a running test, and every spawned process gets the isolated environment of `test/setup.ts`.
  `lifecycle.test.ts` runs every command against the temp helper, `surface.test.ts` covers help, usage and data errors, exit codes, empty states, and the helper failure modes, and `performance.test.ts` counts the fastest of seven runs per path, and of seven `node -e 0` runs for the floor, sampled between the path's runs (the hanging socket check in `surface.test.ts` takes its seven floor runs up front), since load from other test workers only ever adds time; `OVERNOTE_AXI_PERF_REPORT=1` prints the measured table.
- `npm run check` runs typecheck, tests, build, and the skill staleness check; lint errors and flaky tests count as failures.

## 12. Module map

| Path | Responsibility |
|---|---|
| `bin/overnote-axi.ts` | Entry: `--version` fast path, then dynamic import of the CLI |
| `src/version.ts`, `src/meta.ts` | Leaf constants: version, name, description |
| `src/build-info.ts` | Leaf constant: the Overnote commit core was bundled from |
| `src/guidance.ts` | Static guidance shared by the help, the home view, and the skill: home hints, `NOTE_REF_HELP`, workflow, safety |
| `src/cli.ts` | Dispatcher: help, unknown commands, argument validation, error rendering, exit codes |
| `src/registry.ts` | The command list, summaries, and lazy loaders |
| `src/command.ts` | The `CommandSpec` contract and flag accessors |
| `src/args.ts` | Declarative argv parsing, per-command help rendering, did-you-mean (`closest`), and `rebuildInvocation` for hints |
| `src/errors.ts` | `AxiError`, error codes, exit code mapping |
| `src/context.ts` | The `Context` ports with lazy, injectable factories |
| `src/runtime.ts` | Production wiring of the Context (reader, writer, converter, stdin, `open`) |
| `src/output/toon.ts` | Dependency free TOON encoder |
| `src/output/render.ts` | Lists, details, empty states, text blocks, hints, errors, truncation, formatters |
| `src/domain/types.ts` | Shared types and the `NotesReader`, `NotesWriter`, `MarkdownConverter` ports |
| `src/domain/deeplink.ts` | Overnote deeplinks: build, render as markdown, extract, backlink pattern |
| `src/config/paths.ts` | Support, database, runtime, and socket paths; runtime dir trust check |
| `src/store/readonly-db.ts` | `NotesReader` over read-only `node:sqlite` |
| `src/store/refs.ts` | `<note>` parsing and resolution |
| `src/helper/rpc-client.ts` | Newline-delimited JSON-RPC client for the helper socket |
| `src/helper/notes-writer.ts` | `NotesWriter` over the RPC client with error translation |
| `src/markdown/convert.ts` | `@overnote/core` conversion at the document level: compose, block scoped edit, loss checks (the only full core importer; its own chunk) |
| `src/markdown/compose.ts` | Pure no-op rules for append, prepend, and edit retries |
| `src/commands/shared.ts` | Shared flag and argument specs |
| `src/commands/content.ts` | Reading `--content`, `--content -`, `--content-file` |
| `src/commands/write-flow.ts` | `writeContent`: the shared content write path of section 7 |
| `src/commands/note-ops.ts` | Shared organize helpers: fresh resolution through the helper, pin positions, one line labels, the no-op token, and keeping `current` after `create` and `duplicate` |
| `src/commands/listing.ts` | The paged note table `list` and `trash` share: empty state, past the end state, next page hint |
| `src/commands/note-columns.ts` | Row titles, pin positions, previews, and `--fields` columns shared by the note listings |
| `src/commands/*.ts` | One module per command: spec plus `run` |
| `src/integrations/hooks.ts` | Hook install, repair, and removal for Claude Code, Codex, OpenCode; the command a hook runs |
| `src/integrations/codex-config.ts` | Line by line `config.toml` edit that sets `hooks = true` under `[features]` |
| `src/integrations/opencode-plugin.ts` | Source of the managed OpenCode plugin |
| `src/integrations/files.ts` | Atomic, mode keeping writes and safe removals for agent config files |
| `src/integrations/skill.ts` | Skill generation and install |
| `scripts/*.mjs` | Overnote checkout link, esbuild bundle, skill build |
| `test/fixtures/` | Isolation guard, shared fakes, `runCli`, database builder, temp helper, temp home |
| `test/` | Unit, store, command, integration, and built binary tests (section 11) |

## 13. Open source

- MIT licensed, copyright WesleyBLDC (`WesleyBLDC <WesleyBLDC@users.noreply.github.com>` in `package.json`, which also names the repository, homepage, and issue tracker).
- The bundle includes `@overnote/core` (MIT, same author) and its dependencies (Tiptap, ProseMirror, prosemirror-flat-list, markdown-it, linkify-it, mdurl, entities, and others, all MIT or BSD).
  The build reads esbuild's metafile, maps every bundled input under `node_modules` to its package, and writes each package's license text to `dist/THIRD_PARTY_LICENSES.txt`, which ships in the package; the build fails when a bundled package has no license text.
- Contributions follow `AGENTS.md`: no dashes as punctuation in prose, one sentence per line in long Markdown files, and every change keeps `npm run check` green.
