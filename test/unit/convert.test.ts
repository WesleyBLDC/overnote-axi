import { describe, expect, it } from "vitest";

import { converter } from "../../src/markdown/convert.js";

describe("markdown conversion through @overnote/core", () => {
  it("derives every stored field the way the editor does", () => {
    const content = converter.fromMarkdown("# Groceries\n\n- [ ] milk\n- [x] eggs");
    expect(content.title).toBe("Groceries");
    expect(content.markdown).toBe("# Groceries\n\n- [ ] milk\n- [x] eggs");
    expect(JSON.parse(content.rawContent)).toMatchObject({ type: "doc" });
    expect(content.text).toContain("milk");
  });
});
