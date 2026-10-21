// Bundles the CLI into dist/ with zero runtime dependencies.
//
// The entry (dist/overnote-axi.js) stays tiny so `--version` answers before anything else loads.
// Every command and @overnote/core are reached through dynamic import(), so esbuild splits them
// into chunks under dist/chunks/ and a read command never parses the Tiptap and ProseMirror code
// that only writes need.
//
// Two records ship with the bundle:
// - the Overnote commit @overnote/core came from (`<sha>` or `<sha>-dirty`), compiled into
//   src/build-info.ts and shown by `status`; OVERNOTE_REQUIRE_CLEAN=1 (set by `prepack`)
//   refuses a dirty checkout unless OVERNOTE_ALLOW_DIRTY=1;
// - dist/THIRD_PARTY_LICENSES.txt with the license text of every bundled package, found from
//   esbuild's metafile; the build fails when a bundled package has no license text.
//
// `--outdir <dir>` builds somewhere other than dist/ (the built binary tests in test/e2e build a
// private copy, so they never race a concurrent `npm run build`). The dir must be named `dist`,
// because `setup` only installs hooks that point at a `dist/overnote-axi.js`.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

import { overnoteDir, repoRoot } from "./overnote-dir.mjs";

const overnote = overnoteDir();
const outdir = outdirArg(process.argv.slice(2));

function outdirArg(argv) {
  const at = argv.indexOf("--outdir");
  if (at === -1) return path.join(repoRoot, "dist");
  const dir = argv[at + 1];
  if (!dir || path.basename(dir) !== "dist") throw new Error("--outdir needs a directory named dist");
  return path.resolve(dir);
}

function coreRevision() {
  const git = (...args) => execFileSync("git", ["-C", overnote, ...args], { encoding: "utf8" }).trim();
  const sha = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=no", "--", "packages/core") !== "";
  if (dirty && process.env.OVERNOTE_REQUIRE_CLEAN === "1" && process.env.OVERNOTE_ALLOW_DIRTY !== "1") {
    throw new Error(
      `The Overnote checkout at ${overnote} has uncommitted changes in packages/core. ` +
        "Commit them, or set OVERNOTE_ALLOW_DIRTY=1 to ship them anyway.",
    );
  }
  return dirty ? `${sha}-dirty` : sha;
}

const revision = coreRevision();
rmSync(outdir, { recursive: true, force: true });

const result = await build({
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
  legalComments: "none",
  metafile: true,
  chunkNames: "chunks/[name]-[hash]",
  alias: {
    "@overnote/core/text": path.join(overnote, "packages/core/src/lite.ts"),
    "@overnote/core": path.join(overnote, "packages/core/src/index.ts"),
  },
  define: { __OVERNOTE_CORE_REVISION__: JSON.stringify(revision) },
  nodePaths: [path.join(overnote, "node_modules")],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});

chmodSync(path.join(outdir, "overnote-axi.js"), 0o755);
writeFileSync(path.join(outdir, "THIRD_PARTY_LICENSES.txt"), thirdPartyNotices(result.metafile));

/** The package root (the dir holding package.json) of a bundled input under node_modules. */
function packageRoot(input) {
  const absolute = path.resolve(repoRoot, input);
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = absolute.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = absolute.slice(at + marker.length).split(path.sep);
  const depth = rest[0]?.startsWith("@") ? 2 : 1;
  return absolute.slice(0, at + marker.length) + rest.slice(0, depth).join(path.sep);
}

function licenseText(root) {
  const file = readdirSync(root).find((name) => /^(licen[cs]e|copying)([._-]|$)/i.test(name));
  return file ? readFileSync(path.join(root, file), "utf8").trim() : null;
}

function thirdPartyNotices(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const root = packageRoot(input);
    if (root) roots.add(root);
  }
  const sections = [];
  const missing = [];

  const coreLicense = path.join(overnote, "LICENSE");
  if (!existsSync(coreLicense)) missing.push("@overnote/core (Overnote LICENSE)");
  else sections.push(notice("@overnote/core", readFileSync(path.join(overnote, "packages/core/package.json"), "utf8"), readFileSync(coreLicense, "utf8").trim()));

  for (const root of [...roots].sort()) {
    const manifest = readFileSync(path.join(root, "package.json"), "utf8");
    const text = licenseText(root);
    if (!text) missing.push(JSON.parse(manifest).name ?? root);
    else sections.push(notice(JSON.parse(manifest).name, manifest, text));
  }
  if (missing.length > 0) {
    throw new Error(`No license text found for bundled packages: ${missing.join(", ")}`);
  }
  return [
    "overnote-axi bundles the following third party packages. Their license notices follow.",
    "",
    ...sections,
  ].join("\n");
}

function notice(name, manifestText, text) {
  const manifest = JSON.parse(manifestText);
  const rule = "=".repeat(78);
  return [rule, `${name ?? manifest.name}@${manifest.version ?? "unknown"} (${manifest.license ?? "see below"})`, rule, "", text, ""].join("\n");
}
