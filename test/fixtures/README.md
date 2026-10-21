# Test fixtures

Every fixture writes only inside a fresh temporary directory and passes every path it hands to the CLI through `assertIsolated()` (`guard.ts`), which refuses the real home and the real Overnote runtime dir.

`test/setup.ts` isolates the whole run before any test: the Overnote support, runtime and backup dirs point at nonexistent temp paths; `HOME`, `XDG_CONFIG_HOME` and `CODEX_HOME` point at an empty temp home, so `setup` can only write agent config there; and `OVERNOTE_AXI_OPEN_CMD=/usr/bin/true` keeps any spawned CLI from running the real `/usr/bin/open`, which would launch the real Overnote against the real database.
Never unset these in a test, and never call `/usr/bin/open` directly.

- `guard.ts` (scaffold): `assertIsolated()`, `REAL_HOME`, `REAL_RUNTIME_DIR`.
- `fakes.ts` (scaffold, shared by the read and write slices): `FakeStore`, `FakeReader`, `FakeWriter`, `createFakes()` and `fakeContext()`, an in-memory Context with the real core converter, an instant `sleep`, and a recording `openUrl`.
  Steer edge cases with `store.failNext(method, error)`, `store.helperRunning = false`, and `store.afterUpdate` (for example to simulate the open editor saving over a write).
  Slices may extend the fakes, but must keep them faithful to overnote docs/architecture.md section 5.

- `notes-db.ts` (foundation slice): builds a `notes.sqlite` with the helper's schema (overnote docs/architecture.md section 6) in a temp support dir, for read path tests without the helper.
- `temp-helper.ts` (foundation slice): starts the real `OvernoteHelper` binary headless against a temp support dir, runtime dir (created with mode `0o700`, asserted, because the CLI refuses any other mode), socket and backups dir, and stops it after the test.
  The binary comes from `OVERNOTE_HELPER_BIN`, else `<overnote checkout>/helper/.build/release/OvernoteHelper`; when it is missing, integration tests skip with a message instead of failing.
