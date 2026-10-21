# Test fixtures

Owned by the foundation slice.
Every fixture writes only inside a fresh temporary directory and refuses any path outside `os.tmpdir()` or `/tmp`.

- `notes-db.ts`: builds a `notes.sqlite` with the helper's schema (overnote docs/architecture.md section 6) in a temp support dir, for read path tests without the helper.
- `temp-helper.ts`: starts the real `OvernoteHelper` binary headless against a temp support dir, runtime dir, socket and backups dir, and stops it after the test.
  The binary comes from `OVERNOTE_HELPER_BIN`, else `<overnote checkout>/helper/.build/release/OvernoteHelper`; when it is missing, integration tests skip with a message instead of failing.
