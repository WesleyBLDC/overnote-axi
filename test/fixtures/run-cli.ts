/**
 * Runs one CLI invocation through `main()` and captures stdout and the exit code, for command
 * tests. The Context is passed in (usually `fakeContext().context`), so nothing outside the test's
 * own fixtures is touched.
 */
import { main } from "../../src/cli.js";
import type { Context } from "../../src/context.js";

export interface CliResult {
  code: number;
  out: string;
}

export async function runCli(argv: readonly string[], context: Context): Promise<CliResult> {
  let out = "";
  const code = await main({ argv, stdout: { write: (chunk: string) => (out += chunk) }, context });
  return { code, out };
}

/** Joins expected output lines the way the CLI prints them (one trailing newline). */
export function lines(...rows: string[]): string {
  return `${rows.join("\n")}\n`;
}
