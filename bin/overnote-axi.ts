import { nodeTooOld, VERSION } from "../src/version.js";

// Keep this file's static imports to exactly the one above: `--version` must answer without
// loading the command graph (AXI principle 10). Everything else is a dynamic import.
const argv = process.argv.slice(2);
const only = argv.length === 1 ? argv[0] : undefined;

if (only === "--version" || only === "-v" || only === "-V") {
  process.stdout.write(`${VERSION}\n`);
} else if (nodeTooOld(process.versions.node)) {
  // The home view (no args or `home`) runs in session hooks, so it degrades with exit 0 instead
  // of failing the session; every other command is a usage problem the agent can fix.
  const isHome = argv.length === 0 || argv[0] === "home";
  const message = `overnote-axi needs Node 22.16 or newer (running ${process.versions.node})`;
  process.stdout.write(
    isHome
      ? `overnote: unavailable, ${message}\nhelp[1]:\n  Install Node 22.16 or newer, then run overnote-axi\n`
      : `error: ${message}\ncode: VALIDATION_ERROR\nhelp[1]:\n  Install Node 22.16 or newer and run the command again\n`,
  );
  process.exitCode = isHome ? 0 : 2;
} else {
  const { guardStdout, main } = await import("../src/cli.js");
  guardStdout(
    process.stdout,
    (code) => (process.exitCode = code),
    () => process.exit(),
  );
  process.exitCode = await main({ argv });
}
