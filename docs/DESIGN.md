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
  - **append, prepend, `link --into`**: `compose` loads the stored document with `loadDoc(rawContent, text)` and concatenates the addition's blocks (`markdownToDoc`) after or before its blocks, then `buildNoteContent` derives every field; existing blocks survive exactly (the empty caret paragraph at the joining edge is dropped).
  - **`edit`**: block scoped; only top level blocks whose own markdown contains `--old` are serialized, edited, and parsed back, and only they are checked for losses; a match that spans blocks rewrites the whole document.
  - **`update --replace`**: a full rewrite, preceded by `rewriteLosses`, which compares the stored document with its markdown round trip.
  - When an `edit` or `--replace` would lose anything, it fails with `LOSSY_REWRITE`, whose `losses` field names it (`unsupported-content`, `collapsed-toggle`, or `formatting`, such as blank line runs or implicit list numbers); `--allow-loss` writes anyway.
  On the 19 notes of a real database, append kept every block of every note, a whole note rewrite would have changed 6 of them, and a block scoped edit of a word was clean in 104 of 114 cases.
- **One snapshot per command.** Every command runs all of its reads inside one `reader.snapshot()`, a deferred read transaction, so counts, rows, and the current note come from the same WAL snapshot.
  On open the reader checks `PRAGMA user_version` against `SUPPORTED_SCHEMA_VERSIONS` (today `[1]`) and refuses any other with `DATABASE_ERROR` and the hint to update overnote-axi.
- **Helper not running.** Writes fail with `HELPER_NOT_RUNNING` and the hint `overnote-axi open`, which starts Overnote through its Raycast deeplink.
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
The CLI never creates the runtime dir or the database.

### 3.3 Bundling `@overnote/core`

- `scripts/link-overnote.mjs` maintains a git-ignored `.overnote` symlink to the Overnote checkout (`OVERNOTE_DIR`, default `../overnote`); npm runs it before `build`, `test`, and `typecheck`.
- `tsconfig.json` paths and `vitest.config.ts` aliases resolve `@overnote/core` and `@overnote/core/text` through that symlink, so types and tests use the real source.
- `scripts/build.mjs` runs esbuild with `splitting: true`: the entry `dist/overnote-axi.js` is a few hundred bytes, every command is its own chunk, and `src/markdown/convert.ts` (the only importer of the full core entry, reached only through a dynamic import) pulls Tiptap, ProseMirror, and markdown-it into one chunk of about 500 KB that read commands never load.
- Light helpers (`fold`, `displayTitle`) come from `@overnote/core/text`, which has no Tiptap import.
- The published package contains only `dist/`, the skill, `LICENSE`, and `README.md`; `dependencies` stays empty.
- The build records which core it bundled: `git rev-parse --short HEAD` of the Overnote checkout plus `-dirty` when `packages/core` has uncommitted changes, compiled into `src/build-info.ts` and shown by `status`.
  `prepack` builds with `OVERNOTE_REQUIRE_CLEAN=1`, which refuses a dirty core unless `OVERNOTE_ALLOW_DIRTY=1`, and runs the skill check, so a stale or missing `dist/` cannot be packed.
- `bin/overnote-axi.ts` checks `process.versions.node` right after the version fast path: below 22.5 (no `node:sqlite` or `process.getBuiltinModule`) it prints `error: overnote-axi needs Node 22.5 or newer (running <v>)` with `code: VALIDATION_ERROR` and exits 2, except the home view, which prints the same message as a degraded payload and exits 0 so a hook never breaks a session.

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
  A mutation that finds the desired state already in place prints `(no-op)` and exits 0.
- Errors print `error:`, `code:`, optional detail fields, and `help[N]:` with the command that fixes the problem.
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
| `AMBIGUOUS_NOTE` | A fragment or title matches several notes; up to 5 candidates are listed | `overnote-axi read <id>` |
| `NOTE_TRASHED` | A content write targets a note in Recently Deleted | `overnote-axi recover <id>` |
| `NOT_PINNED` | `move` on an unpinned note | `overnote-axi pin <id>` |
| `STALE_WRITE` | The note changed after the caller read it; nothing was written; `updatedAt` holds the stored value | `overnote-axi read <id>` |
| `TEXT_NOT_FOUND` | `edit --old` text is not in the note | `overnote-axi read <id> --full` |
| `AMBIGUOUS_TEXT` | `edit --old` text occurs more than once; `matches` holds the count | add context to `--old`, or pass `--all` |
| `LOSSY_REWRITE` | `edit` or `update --replace` would lose stored content; `losses` names what | `overnote-axi update <id> --content ...` (append keeps everything), or repeat with `--allow-loss` |
| `OVERWRITTEN_BY_EDITOR` | The write landed, then the open editor saved over it within the verify window | `overnote-axi read <id>`, then retry once the person stops typing |
| `HELPER_NOT_RUNNING` | The socket is missing, refused, or untrusted | `overnote-axi open` |
| `HELPER_TIMEOUT` | No answer within the protocol timeout (3 s) | retry, then `overnote-axi status` |
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

ULIDs never contain `u`, so `current` cannot collide with an id.
Several matches produce `AMBIGUOUS_NOTE` with the candidates as rows; zero produce `NOTE_NOT_FOUND`.
Reads resolve trashed notes too (and say `state: trashed`); content writes refuse them with `NOTE_TRASHED`.
The irreversible `delete --permanent` accepts only a full id (section 6.14).

## 6. Command surface

Flags always follow the command, `--help` works everywhere, and short flags do not exist.
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
  helper: running v0.3.0
  notes: 42 live
  pinned: 3
  trash: 5
current:
  id: 01JAB3K9QW
  title: Standup
pinned[3]{id,title,updated}:
  01JAB3K9QW,Standup,2026-10-20
  01JA7Q2M1C,Groceries,2026-10-18
  01J9ZT4E8D,Reading list,2026-09-30
recent[2]{id,title,updated}:
  01JAC0P5RT,Invoice draft,2026-10-19
  01JAB9V7XN,Trip ideas,2026-10-17
help[3]:
  overnote-axi read <id>
  overnote-axi search "<text>"
  overnote-axi create --content "<markdown>"
```

- Helper states: `running v<version>`, `stopped (reads work; writes need overnote-axi open)`, or `not answering` when the socket accepts but stays silent.
  The probe (`context.probeHelper()`) has one 400 ms budget for connect plus ping (`PROBE_TIMEOUT_MS`) and never throws, so a hung helper cannot stall a session start.
- No database: `overnote: no notes database yet` plus the `overnote-axi open` hint, exit 0 (the hook must never fail a session).
- No notes: `notes: 0 live` and only the `create` hint.
- Pinned rows are capped by `--pinned-limit` (at most 9, the app's ⌘1 to ⌘9) and recent rows exclude pinned notes.
  When pinned rows are cut, a `overnote-axi list --pinned` hint names the rest.
- The `help` lines come from `HOME_HINTS` in `src/guidance.ts`, the same block the skill renders (section 9).

### 6.2 `list`

Live notes in the app's order: pinned first in pin order, then by the sort column descending, then id.
Flags: `--limit <n>` (50), `--offset <n>` (0), `--pinned`, `--sort updated|accessed|created` (updated), `--fields <a,b>` from `id,title,updated,created,accessed,deleted,chars,pinned,preview` (default `id,title,updated`).

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
- `pinned` is the 1 based pin position or empty; `chars` is the code point count of the text (architecture §5 `charCount`); `preview` is the first 100 characters of text on one line.
- Empty: `notes: 0 live notes` (or `notes: 0 pinned notes`) with a `create` hint.

### 6.3 `search <query>`

The app's matching: folded substring on title or text (architecture §5 fold rule), title matches first, then pinned, then most recently updated.
Flags: `--limit <n>` (20), `--trash`, `--fields` from `id,title,match,updated,chars,pinned` (default `id,title,match`).

```
count: 2 of 2 notes matching "standup"
hits[2]{id,title,match}:
  01JAB3K9QW,Standup,title
  01JAC0P5RT,Weekly sync,"...moved the standup to 9:30 so Sam can..."
help[1]:
  overnote-axi read <id>
```

- `match` is `title` for title hits, else about 80 characters of text around the first match on one line.
- Empty: `hits: 0 notes match "standup"` with `search --trash` and `create` hints; the `--trash` hint keeps the other flags of the call.
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
  links: 2 out, 1 in
markdown:
  # Standup
  - [ ] demo the CLI
  ...
  ... (truncated, showing 1200 of 2475 markdown chars)
help[1]:
  overnote-axi read 01JAB3K9QW --full
```

- Bodies truncate at 1200 code points of markdown unless `--full`; the hint appears only when truncated.
- `chars` is the plain text count (section 4); the truncation line counts markdown, and says so.
- Several references print `count: <n> notes` first, then one `note:` block per note, in order.
  When any body was truncated, one hint follows, listing only the truncated ids: `overnote-axi read <id> <id> --full`.
- A trashed note shows `state: trashed` and `deleted: <date>`.
- An empty note prints `markdown: (empty)`.

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
- Empty sides print `outgoing: 0 links` and `backlinks: 0 notes link here`.

### 6.6 `status`

```
helper:
  state: running
  version: 0.3.0
  pid: 4242
database:
  path: ~/Library/Application Support/com.raycast.macos/extensions/overnote/notes.sqlite
  schema: 1
  notes: 42 live
  trash: 5
socket: /tmp/overnote-501/helper.sock
backups:
  count: 10
  latest: 2026-10-20
```

- `backups` comes from `system.status` and is omitted while the helper is stopped.
- A `build` block shows the CLI version and the Overnote commit its core came from (`core: 4784d66`, or `4784d66-dirty`).

### 6.7 `open [note]`

Opens the Overnote panel on a note (`toggle-notes` deeplink with `{ id }`) or on the last note (`open-notes` deeplink) by running `/usr/bin/open <url>` without a shell.
This also starts the helper, which is why write errors point here.
Output: `opened: 01JAB3K9QW Standup` or `opened: Overnote`.
`OVERNOTE_AXI_OPEN_CMD`, honored only when set, replaces `/usr/bin/open` with another absolute path; the test suite sets it so no test can launch the real Overnote (section 11).

### 6.8 `create`

Flags: content flags, `--title <text>` (prepends `# <text>` and a blank line), `--pin`, `--open` (sends `show: true`).
At least one of `--title` or content is required; an empty note is a usage error.

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

### 6.9 `update <note>`

Modes: `--append` (default), `--prepend`, `--replace`; giving more than one is a usage error.
Content is required.

- Append and prepend add the addition's blocks after or before the stored document's blocks (`converter.compose`, section 3.1), so every existing block, including content markdown cannot express, is kept exactly.
- Append is a no-op when the trimmed stored markdown already ends with the trimmed addition after normalization (`converter.normalize`, so `* item` matches the stored `- item`); prepend when it already starts with it (exit 0, `(no-op)`).
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
- `--old` equal to `--new` is a no-op.
- Only the top level blocks that contain the match are rewritten (`converter.edit`, section 3.1); the rest of the note is untouched.
  A match that spans blocks rewrites the whole note.
- If the rewritten blocks (or the note) lose content, the edit fails with `LOSSY_REWRITE` unless `--allow-loss`.

```
edited:
  id: 01JAB3K9QW
  replaced: 1
  updatedAt: 1792543300000
```

### 6.11 `link <note>`

Without `--into`, prints the note's link and writes nothing:

```
link:
  id: 01JA7Q2M1C
  url: "raycast://extensions/wesleybldc/overnote/toggle-notes?context=%7B%22id%22%3A%2201JA7Q2M1C%22%7D"
  markdown: "[Groceries](raycast://...)"
```

With `--into <target>`, appends (or with `--prepend`, prepends) `[<label>](<url>)` to the target as its own paragraph, through the same document level path as `update` (`writeContent` plus `converter.compose`).
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

`notes.duplicate` with an optional `--suffix <text>`; prints the new note like `create`.

### 6.14 `delete <note>`

- Default: `notes.delete`, a soft delete into Recently Deleted (the pin is cleared; the app purges after 60 days).
  A note already in the trash is a no-op.
- `--permanent` accepts only a full 26 character id; a fragment or `title:` reference is a usage error whose hint shows the resolved full id, and `current` is refused, because the irreversible path must never act on a guess or a fallback.
  If the note is live it is trashed first; then the CLI re-reads it with `notes.get`, confirms `deletedAt` is set, and calls `notes.permanentlyDelete`.
  The writer maps the protocol 404 to `NOTE_NOT_FOUND` like everywhere else; `delete` itself turns a 404 from `notes.get` or `notes.permanentlyDelete` for a full id into `(no-op)`, since the note is already gone.

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
help[2]:
  overnote-axi recover <id>
  overnote-axi trash --empty --permanent
```

- `--empty` without `--permanent` is a usage error that explains what `--permanent` will erase (with the count).
- `--empty --permanent` calls `notes.emptyTrash` and prints `emptied: 5 notes erased`; an empty trash is a no-op.
- `--expected-count <n>` makes it refuse (`STALE_WRITE`, with the current count) unless Recently Deleted still holds exactly `n` notes, so notes trashed after the agent looked are not erased unseen; the usage error of `--empty` alone suggests it with the current count.
- The paging hint keeps `--fields` and `--limit`.
- Empty listing: `trash: 0 notes in Recently Deleted`.

### 6.17 `setup [hooks|skill]`

See section 8.

## 7. Safety model for writes

- **Single writer.** The CLI has no SQLite write path at all; the reader opens read-only and sets `query_only`.
- **Stale write guard.** Every content write sends `expectedUpdatedAt`, so the helper refuses it when the note changed between the CLI's read and its write (architecture §5 `notes.update` conflict result).
  `--expected-updated-at` extends that window back to the agent's own earlier `read`, and `--replace` requires it, because replacing a note the person edited meanwhile would silently destroy their work.
- **The guard does not cover unsaved typing.** The open editor has its own policy: on a conflict it retries with the stored `updatedAt` and its local edit wins, and while the person is typing it keeps its local content (Overnote `editor/src/session/session.ts`, `saveContent` and `refresh`).
  So if the person is editing the same note, or has a 300 ms debounced save pending, the CLI's write succeeds and the editor's next save then overwrites it.
  The CLI cannot prevent that, so it makes it visible:
  - when the target is the note open in Overnote (`currentNoteId`), the output carries `warning: note is open in Overnote; unsaved edits there win over this write`;
  - for that note only, `writeContent` waits `VERIFY_DELAY_MS` (400 ms, past the autosave debounce), re-reads it with `notes.get`, and fails with `OVERWRITTEN_BY_EDITOR` when `updatedAt` moved and the stored `rawContent` is no longer what it wrote; writes to any other note skip the wait.
  - A real fix needs an Overnote protocol change (a way to flush or lock the editor's pending save), which is out of scope here and tracked as a follow up.
- **Shared write flow.** `update`, `edit`, and `link --into` all run `writeContent` (`src/commands/write-flow.ts`): resolve, fresh `notes.get`, `deletedAt` check, `--expected-updated-at` check, plan, loss check, `notes.update` with `expectedUpdatedAt`, then the open note warning and verify.
- **Idempotent mutations.** Pin, unpin, delete, recover, and append report no-ops instead of errors, so retries are safe.
- **What `--permanent` unlocks.** Only two operations erase data irreversibly: `delete --permanent` and `trash --empty --permanent`.
  Neither has a default, a prompt, or an environment variable that enables it; the flag must be on the command line.
  `delete --permanent` takes only a full id and confirms `deletedAt` through the helper first; `trash --empty --permanent` takes `--expected-count` to pin what the agent saw.
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
  Otherwise it runs `"<process.execPath>" "<realpath of dist/overnote-axi.js>"`, both absolute and quoted, so the hook never falls back to an older `node` on the agent's `PATH`.
- **No dev hooks.** `setup` refuses with `VALIDATION_ERROR` when the running script ends in `.ts` or is not `dist/overnote-axi.js` (or an installed bin that resolves to it), so a run under tsx or vitest can never register a hook that points at source.
- **Idempotent and self repairing.** Entries are recognized by the `overnote-axi` marker in the command; a repeat install with the same command and timeout changes nothing (`unchanged`); a moved binary or a different timeout is rewritten in place (`updated`).
- **Non-destructive.** JSON files are parsed and rewritten with only the hook entry changed, other keys and hooks kept in order; a file that does not parse is left alone and reported as `IO_ERROR`.
  Codex `config.toml` is edited line by line with no TOML parser: `hooks = true` is added under an existing `[features]` table (or the table is appended), and no other line is rewritten.
  The OpenCode plugin starts with a managed marker comment; a file at that path without the marker is never overwritten or removed, and only that agent reports `IO_ERROR`.
  Every write is atomic (temp file in the same directory, then rename) and keeps the file mode.
- **Per agent results.** Each agent gets its own row and change (`installed`, `updated`, `unchanged`, `removed`, `absent`, or `error` with its code), so a partial failure is visible and the others still apply; the exit code is 1 when any row is `error`.
- **Uninstall** removes only entries carrying the marker (and the managed plugin), deletes an empty `SessionStart` array it created, and reports `removed` or `absent`.
  It leaves `[features] hooks = true` in Codex `config.toml`, because other tools rely on it.
- **Explicit opt in.** Only `setup` writes agent configuration; no other command does, and no lifecycle hook writes notes (section 2).
- **Global, not directory scoped.** Notes have no project link, so the payload is the same in every directory and only user level config is written (section 2).
- **Hook cost.** `home --limit 3 --pinned-limit 3` is the whole payload: at most 24 lines (bin, description, five `overnote` lines, three `current` lines, three pinned and three recent rows with their headers, and at most four hints with their header), enforced by a test on a fixture with 9 pins and 20 other notes.
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
  Its body is the home view with live state stripped: the static guidance in `src/guidance.ts` (`HOME_HINTS`, `WORKFLOW`, `SAFETY`, shared with the home view) plus the top-level help's command list and the note reference rules, so it cannot drift.
  `npm run check` and `prepack` run it with `--check`, which fails on a stale file and while the scaffold placeholder is still in place.
- Frontmatter: `name: overnote-axi` and a trigger shaped `description` naming the intents (Overnote, Raycast notes, scratchpad, quick note, read, search, append, check off a task, pin, link, delete).
  It stays user invocable, so `/overnote-axi` loads it explicitly.
- The body strips live state, tells the agent to run `overnote-axi` first, lists the workflow (search, read, then `update`/`edit` with `--expected-updated-at`), the safety rules, and the exit codes.
- **Invocation rule.** A skill can be present while the binary is not on `PATH`, so the committed `SKILL.md` uses the bare `overnote-axi` and tells the agent: if `command -v overnote-axi` fails, run `npm install -g .` in this repository, or use `node <repo>/dist/overnote-axi.js`.
  `setup skill` writes its installed copy with the command `hookCommand()` resolves, so a skill installed by setup always runs.
  No `npx` form of this CLI may appear until the npm name is published and owned (section 2); a unit test checks the committed file and the generated skill for it.
- Install paths: `overnote-axi setup skill` installs for Claude Code only (`~/.claude/skills/overnote-axi/SKILL.md`; `--agent` other than `claude` is a usage error for `skill`).
  Other agents use `npx skills add WesleyBLDC/axi-overnote --skill overnote-axi` once the repository is public; that runs the skills installer, not this CLI.
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

- **Never real notes, never real agent config.** Before any test runs, `test/setup.ts` points `OVERNOTE_SUPPORT_DIR`, `OVERNOTE_RUNTIME_DIR`, and `OVERNOTE_BACKUP_DIR` at nonexistent temp paths, and `HOME`, `XDG_CONFIG_HOME`, and `CODEX_HOME` at an empty temp home, then asserts that none of them lies under the real home (`os.userInfo().homedir`) or `/tmp/overnote-<uid>`.
  Fixtures pass every path they hand to the CLI through the same `assertIsolated()` (`test/fixtures/guard.ts`).
- **Never the real app.** `test/setup.ts` sets `OVERNOTE_AXI_OPEN_CMD=/usr/bin/true`, so no test, and no CLI process a test spawns, runs `/usr/bin/open` with a `raycast://` URL, which would launch the real Overnote helper against the real database.
- **Shared fakes.** `test/fixtures/fakes.ts` (scaffold) provides `FakeReader`, `FakeWriter`, and `fakeContext()` over one in-memory store, faithful to architecture §5 including conflicts, 404 and 409 errors, and an `afterUpdate` hook that simulates the open editor saving over a write.
- **Unit** (`test/unit/`): TOON encoder against spec cases, argument parsing, rendering, the registry contract (every command loads a documented spec), note reference parsing, markdown composition, deeplink parsing, hook JSON merging on a temp `HOME`, skill generation.
- **Read path** (`test/store/`): a fixture builder creates `notes.sqlite` with the schema of architecture §6 in a temp support dir, so ordering, folding, paging, counts, and backlinks are checked without the helper.
- **Commands** (`test/commands/`): each command runs through `main()` with `fakeContext()`, asserting exact TOON output, empty states, hints (including carried forward flags), error codes, and exit codes.
- **Integration** (`test/integration/`): `test/fixtures/temp-helper.ts` starts the real `OvernoteHelper` (`OVERNOTE_HELPER_BIN`, default `<overnote>/helper/.build/release/OvernoteHelper`) with `--support-dir`, `--socket`, `--pid-file`, `--editor-dir` all in a fresh short `/tmp/onx-*` dir, `--headless`, and `OVERNOTE_BACKUP_DIR` in the same dir, then drives the CLI end to end: create, read back from SQLite, update with and without a conflict, edit, link, pin and move, delete, recover, empty trash.
  When the binary is missing the suite skips with a clear message.
- **Built binary** (`test/e2e/`): spawns `dist/overnote-axi.js` for `--version`, help, a read, and a write against the temp helper, `list` piped into a reader that closes early (exit 0, empty stderr), `home` against a socket that never answers, and the hook payload line count, and checks the timing budget against the `node -e 0` floor.
- `npm run check` runs typecheck, tests, build, and the skill staleness check; lint errors and flaky tests count as failures.

## 12. Module map

| Path | Responsibility |
|---|---|
| `bin/overnote-axi.ts` | Entry: `--version` fast path, then dynamic import of the CLI |
| `src/version.ts`, `src/meta.ts` | Leaf constants: version, name, description |
| `src/build-info.ts` | Leaf constant: the Overnote commit core was bundled from |
| `src/guidance.ts` | Static guidance shared by the home view and the skill |
| `src/cli.ts` | Dispatcher: help, unknown commands, argument validation, error rendering, exit codes |
| `src/registry.ts` | The command list, summaries, and lazy loaders |
| `src/command.ts` | The `CommandSpec` contract and flag accessors |
| `src/args.ts` | Declarative argv parsing, per-command help rendering, and `rebuildInvocation` for hints |
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
| `src/markdown/compose.ts` | Pure no-op rules for append and prepend |
| `src/commands/shared.ts` | Shared flag and argument specs |
| `src/commands/content.ts` | Reading `--content`, `--content -`, `--content-file` |
| `src/commands/write-flow.ts` | `writeContent`: the shared content write path of section 7 |
| `src/commands/*.ts` | One module per command: spec plus `run` |
| `src/integrations/hooks.ts` | Hook install, repair, and removal for Claude Code, Codex, OpenCode |
| `src/integrations/skill.ts` | Skill generation and install |
| `scripts/*.mjs` | Overnote checkout link, esbuild bundle, skill build |
| `test/fixtures/` | Isolation guard, shared fakes, database builder, temp helper |
| `test/` | Unit, store, command, integration, and built binary tests (section 11) |

## 13. Open source

- MIT licensed, copyright Wesley Dela Cruz.
- The bundle includes `@overnote/core` (MIT, same author) and its dependencies (Tiptap, ProseMirror, prosemirror-flat-list, markdown-it, linkify-it, mdurl, entities, and others, all MIT or BSD).
  The build reads esbuild's metafile, maps every bundled input under `node_modules` to its package, and writes each package's license text to `dist/THIRD_PARTY_LICENSES.txt`, which ships in the package; the build fails when a bundled package has no license text.
- Contributions follow `AGENTS.md`: no dashes as punctuation in prose, one sentence per line in long Markdown files, and every change keeps `npm run check` green.
