// Leaf module: which @overnote/core the bundle was built from. scripts/build.mjs replaces the
// global below with `<short sha>` or `<short sha>-dirty` at build time; unbundled runs (vitest,
// tsc) see `source`. `status` prints it.
declare const __OVERNOTE_CORE_REVISION__: string | undefined;

export const CORE_REVISION: string =
  typeof __OVERNOTE_CORE_REVISION__ === "string" ? __OVERNOTE_CORE_REVISION__ : "source";
