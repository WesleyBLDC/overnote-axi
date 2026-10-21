// Bundles the CLI into dist/ with zero runtime dependencies.
//
// The entry (dist/overnote-axi.js) stays tiny so `--version` answers before anything else loads.
// Every command and @overnote/core are reached through dynamic import(), so esbuild splits them
// into chunks under dist/chunks/ and a read command never parses the Tiptap and ProseMirror code
// that only writes need.
import { chmodSync, rmSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

import { overnoteDir, repoRoot } from "./overnote-dir.mjs";

const overnote = overnoteDir();
const outdir = path.join(repoRoot, "dist");

rmSync(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: repoRoot,
  entryPoints: { "overnote-axi": "bin/overnote-axi.ts" },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "linked",
  chunkNames: "chunks/[name]-[hash]",
  alias: {
    "@overnote/core/text": path.join(overnote, "packages/core/src/lite.ts"),
    "@overnote/core": path.join(overnote, "packages/core/src/index.ts"),
  },
  nodePaths: [path.join(overnote, "node_modules")],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});

chmodSync(path.join(outdir, "overnote-axi.js"), 0o755);
