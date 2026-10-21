// Generates skills/overnote-axi/SKILL.md from repoSkill() in src/integrations/skill.ts, so the
// skill cannot drift from the CLI. `--check` writes nothing and fails when the committed file is
// stale.
//
// The TypeScript source is bundled in memory with esbuild. Dynamic imports (the command modules
// and the runtime wiring) are left external: generating the skill never calls them.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

import { repoRoot } from "./overnote-dir.mjs";

const file = path.join(repoRoot, "skills", "overnote-axi", "SKILL.md");
const relative = path.relative(repoRoot, file);
const check = process.argv.includes("--check");

const result = await build({
  absWorkingDir: repoRoot,
  stdin: { contents: 'export { repoSkill } from "./src/integrations/skill.ts";', resolveDir: repoRoot, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "warning",
  plugins: [
    {
      name: "external-dynamic-imports",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => (args.kind === "dynamic-import" ? { path: args.path, external: true } : undefined));
      },
    },
  ],
});

const source = result.outputFiles[0].text;
const { repoSkill } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const expected = repoSkill();

let current = "";
try {
  current = readFileSync(file, "utf8");
} catch {
  // A missing file is stale too.
}

if (check) {
  if (current !== expected) {
    process.stderr.write(`build-skill: ${relative} is stale; run npm run build:skill\n`);
    process.exit(1);
  }
  process.stdout.write(`build-skill: ${relative} is up to date\n`);
} else if (current === expected) {
  process.stdout.write(`build-skill: ${relative} unchanged\n`);
} else {
  writeFileSync(file, expected);
  process.stdout.write(`build-skill: wrote ${relative}\n`);
}
