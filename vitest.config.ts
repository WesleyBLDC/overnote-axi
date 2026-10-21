import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
// `.overnote` is the symlink scripts/link-overnote.mjs maintains (npm runs it before `npm test`).
const core = path.join(root, ".overnote", "packages", "core", "src");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@overnote\/core\/text$/, replacement: path.join(core, "lite.ts") },
      { find: /^@overnote\/core$/, replacement: path.join(core, "index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    // Integration tests start a real helper process; give them room on a cold machine.
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
