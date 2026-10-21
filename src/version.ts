// Leaf module: no imports at all. bin/overnote-axi.ts reads it before the command graph loads,
// so `--version` costs nothing beyond Node's own startup. Keep it in sync with package.json
// (test/unit/version.test.ts checks).
export const VERSION = "0.1.0";
