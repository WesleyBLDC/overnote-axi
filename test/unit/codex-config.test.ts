import { describe, expect, it } from "vitest";

import { enableCodexHooks } from "../../src/integrations/codex-config.js";
import { AxiError } from "../../src/errors.js";

describe("enableCodexHooks", () => {
  it("creates the features table for a missing file", () => {
    expect(enableCodexHooks(null)).toEqual({ text: "[features]\nhooks = true\n", changed: true });
  });

  it("creates the table in an empty file", () => {
    expect(enableCodexHooks("")).toEqual({ text: "[features]\nhooks = true\n", changed: true });
  });

  it("appends the table after other content with one blank line, keeping every line", () => {
    const before = 'model = "o3"\n\n[mcp_servers.x]\ncommand = "x"\n';
    expect(enableCodexHooks(before).text).toBe(`${before}\n[features]\nhooks = true\n`);
  });

  it("adds the key right under an existing features table", () => {
    const before = "[features]\nweb_search = true\n\n[other]\nhooks = false\n";
    expect(enableCodexHooks(before)).toEqual({
      text: "[features]\nhooks = true\nweb_search = true\n\n[other]\nhooks = false\n",
      changed: true,
    });
  });

  it("is a no-op when hooks is already true, comments included", () => {
    const before = "[features]\nhooks = true # needed by overnote-axi\n";
    expect(enableCodexHooks(before)).toEqual({ text: before, changed: false });
  });

  it("turns an explicit false into true on that line only", () => {
    expect(enableCodexHooks("[features]\n  hooks=false  # off\nx = 1").text).toBe("[features]\n  hooks=true  # off\nx = 1");
  });

  it("honors a dotted key at the top level instead of adding a duplicate table", () => {
    expect(enableCodexHooks("features.hooks = true\n")).toEqual({ text: "features.hooks = true\n", changed: false });
    expect(enableCodexHooks("features.hooks = false\n").text).toBe("features.hooks = true\n");
  });

  it("accepts quoted keys and table names instead of adding a duplicate key", () => {
    expect(enableCodexHooks('[features]\n"hooks" = false\n').text).toBe('[features]\n"hooks" = true\n');
    expect(enableCodexHooks("[features]\n'hooks' = true\n")).toEqual({ text: "[features]\n'hooks' = true\n", changed: false });
    expect(enableCodexHooks('["features"]\nx = 1\n').text).toBe('["features"]\nhooks = true\nx = 1\n');
    expect(enableCodexHooks('"features"."hooks" = false\n').text).toBe('"features"."hooks" = true\n');
    expect(() => enableCodexHooks("'features' = { hooks = true }\n")).toThrow(AxiError);
  });

  it("ignores hooks keys in other tables and features subtables", () => {
    const before = "[features.extra]\nhooks = true\n";
    expect(enableCodexHooks(before).text).toBe(`${before}\n[features]\nhooks = true\n`);
  });

  it("keeps CRLF line endings", () => {
    expect(enableCodexHooks("[features]\r\nx = 1\r\n").text).toBe("[features]\r\nhooks = true\r\nx = 1\r\n");
  });

  it("refuses an inline features table", () => {
    expect(() => enableCodexHooks("features = { web_search = true }\n")).toThrow(AxiError);
  });
});
