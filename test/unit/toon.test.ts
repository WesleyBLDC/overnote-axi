import { describe, expect, it } from "vitest";

import { encode, encodePrimitive } from "../../src/output/toon.js";

describe("encode", () => {
  it("writes objects, nested objects and primitives", () => {
    expect(encode({ id: 1, name: "Ada", meta: { active: true, note: null } })).toBe(
      ["id: 1", "name: Ada", "meta:", "  active: true", "  note: null"].join("\n"),
    );
  });

  it("writes inline primitive arrays and empty arrays", () => {
    expect(encode({ tags: ["a", "b"], none: [] })).toBe("tags[2]: a,b\nnone: []");
  });

  it("writes uniform object arrays in tabular form", () => {
    expect(
      encode({
        notes: [
          { id: "01A", title: "Fix auth bug", chars: 12 },
          { id: "01B", title: "Plan, then ship", chars: 0 },
        ],
      }),
    ).toBe(['notes[2]{id,title,chars}:', "  01A,Fix auth bug,12", '  01B,"Plan, then ship",0'].join("\n"));
  });

  it("uses nested field groups for uniform object columns", () => {
    expect(encode({ rows: [{ id: 1, at: { d: 2 } }, { id: 2, at: { d: 3 } }] })).toBe(
      "rows[2]{id,at{d}}:\n  1,2\n  2,3",
    );
  });

  it("uses keyed tabular form for objects of uniform objects", () => {
    expect(encode({ users: { alice: { age: 3 }, bob: { age: 4 } } })).toBe("users[2:]{age}:\n  alice: 3\n  bob: 4");
  });

  it("falls back to list form for mixed arrays", () => {
    expect(encode({ items: [1, { a: 1, b: [1, 2] }, [3], {}] })).toBe(
      ["items[4]:", "  - 1", "  - a: 1", "    b[2]: 1,2", "  - [1]: 3", "  -"].join("\n"),
    );
  });

  it("drops undefined fields and normalizes numbers", () => {
    expect(encode({ a: undefined, b: -0, c: Number.NaN, d: 1.5 })).toBe("b: 0\nc: null\nd: 1.5");
  });
});

describe("encodePrimitive quoting", () => {
  it.each([
    ["", '""'],
    [" padded", '" padded"'],
    ["true", '"true"'],
    ["42", '"42"'],
    ["1e-6", '"1e-6"'],
    ["a:b", '"a:b"'],
    ["a,b", '"a,b"'],
    ["- item", '"- item"'],
    ["#tag", '"#tag"'],
    ["[x]", '"[x]"'],
    ["line\nbreak", '"line\\nbreak"'],
    ['say "hi"', '"say \\"hi\\""'],
    ["plain words ok", "plain words ok"],
    ["émoji 🎉", "émoji 🎉"],
  ])("%j encodes as %s", (input, expected) => {
    expect(encodePrimitive(input)).toBe(expected);
  });
});
