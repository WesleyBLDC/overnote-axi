import { VERSION } from "../src/version.js";

// Keep this file's static imports to exactly the one above: `--version` must answer without
// loading the command graph (AXI principle 10). Everything else is a dynamic import.
const argv = process.argv.slice(2);
const only = argv.length === 1 ? argv[0] : undefined;

if (only === "--version" || only === "-v" || only === "-V") {
  process.stdout.write(`${VERSION}\n`);
} else {
  const { main } = await import("../src/cli.js");
  process.exitCode = await main({ argv });
}
