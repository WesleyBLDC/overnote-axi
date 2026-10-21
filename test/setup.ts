/**
 * Runs before every test file. Points the CLI's data locations at a folder that does not exist,
 * so a test that forgets to set its own paths fails with DATABASE_NOT_FOUND or HELPER_NOT_RUNNING
 * instead of ever reading or writing Wesley's real notes. Tests that need data create their own
 * temporary support and runtime dirs (see test/fixtures/).
 */
import os from "node:os";
import path from "node:path";

const nowhere = path.join(os.tmpdir(), `overnote-axi-test-nowhere-${process.pid}`);
process.env.OVERNOTE_SUPPORT_DIR = path.join(nowhere, "support");
process.env.OVERNOTE_RUNTIME_DIR = path.join(nowhere, "run");
process.env.OVERNOTE_BACKUP_DIR = path.join(nowhere, "backups");
