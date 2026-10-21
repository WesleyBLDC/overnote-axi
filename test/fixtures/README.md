# Test fixtures

Every fixture writes only inside a fresh temporary directory and passes every path it hands to the CLI through `assertIsolated()` (`guard.ts`), which refuses the real home and the real Overnote runtime dir.

`test/setup.ts` isolates the whole run before any test: the Overnote support, runtime and backup dirs point at nonexistent temp paths; `HOME`, `XDG_CONFIG_HOME` and `CODEX_HOME` point at an empty temp home, so `setup` can only write agent config there; and `OVERNOTE_AXI_OPEN_CMD=/usr/bin/true` keeps any spawned CLI from running the real `/usr/bin/open`, which would launch the real Overnote against the real database.
Never unset these in a test, and never call `/usr/bin/open` directly.

- `guard.ts`: `assertIsolated()`, `REAL_HOME`, `REAL_RUNTIME_DIR`.
- `fakes.ts`: `FakeStore`, `FakeReader`, `FakeWriter`, `createFakes()` and `fakeContext()`, an in-memory Context with the real core converter, an instant `sleep`, and a recording `openUrl`.
  Steer edge cases with `store.failNext(method, error)`, `store.helperRunning = false`, and `store.afterUpdate` (for example to simulate the open editor saving over a write).
  Extend the fakes as needed, but keep them faithful to overnote docs/architecture.md section 5.

- `run-cli.ts`: `runCli(argv, context)` runs one invocation through `main()` and returns the exit code and stdout; `lines()` builds the expected output.
- `notes-db.ts`: `createNotesDb()` builds a `notes.sqlite` with the helper's schema (overnote docs/architecture.md section 6) in a temp support dir, for read path tests without the helper.
  Seed notes with `add()` (the same input as `FakeStore.add`, folded columns derived like the helper), set the current note with `setCurrent()`, point the CLI at it with `env()`, and call `cleanup()` after the test.
  `userVersion` and `noSchema` build the unsupported and broken database cases.
- `temp-helper.ts`: starts the real `OvernoteHelper` binary headless against a temp support dir, runtime dir (created with mode `0o700`, asserted, because the CLI refuses any other mode), socket and backups dir, and stops it after the test.
  The binary comes from `OVERNOTE_HELPER_BIN`, else `<overnote checkout>/helper/.build/release/OvernoteHelper`; when it is missing, `helperBinary()` returns null and integration tests skip with `HELPER_MISSING` instead of failing.
  `startTempHelper()` returns the paths, `env()` for a CLI process, `call()` for direct RPC setup, `stop()`, and `cleanup()`.
- `temp-home.ts`: `tempHome()` builds a fresh, empty home (with `CODEX_HOME` and `XDG_CONFIG_HOME` inside it) for the `setup` tests, plus a stand-in built CLI so `resolveProgram()` accepts it.
  `linkOnPath()` puts an `overnote-axi` link on a private PATH dir, and `remove()` deletes it all.
