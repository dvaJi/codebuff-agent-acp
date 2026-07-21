import { describe, expect, it } from "vitest";

import {
  isGatedTool,
  toolKind,
  toolLocations,
  toolScopeDescription,
  toolTitle,
} from "../src/mapping.js";

describe("isGatedTool", () => {
  it("flags mutating and shell tools", () => {
    expect(isGatedTool("run_terminal_command")).toBe(true);
    expect(isGatedTool("write_file")).toBe(true);
    expect(isGatedTool("str_replace")).toBe(true);
    expect(isGatedTool("apply_patch")).toBe(true);
    expect(isGatedTool("propose_write_file")).toBe(true);
    expect(isGatedTool("run_file_change_hooks")).toBe(true);
  });

  it("does not flag read-only tools", () => {
    expect(isGatedTool("read_files")).toBe(false);
    expect(isGatedTool("glob")).toBe(false);
    expect(isGatedTool("code_search")).toBe(false);
    expect(isGatedTool("web_search")).toBe(false);
    expect(isGatedTool("unknown_tool")).toBe(false);
  });
});

describe("toolKind", () => {
  it.each([
    ["read_files", "read"],
    ["read_subtree", "read"],
    ["list_directory", "read"],
    ["find_files", "search"],
    ["glob", "search"],
    ["code_search", "search"],
    ["web_search", "fetch"],
    ["read_docs", "fetch"],
    ["run_terminal_command", "execute"],
    ["skill", "execute"],
    ["write_file", "edit"],
    ["str_replace", "edit"],
    ["apply_patch", "edit"],
    ["think_deeply", "think"],
    ["write_todos", "think"],
    ["end_turn", "think"],
    ["spawn_agents", "other"],
    ["totally_unknown", "other"],
  ])("classifies %s as %s", (tool, kind) => {
    expect(toolKind(tool)).toBe(kind);
  });
});

describe("toolTitle", () => {
  it("renders the command for run_terminal_command", () => {
    expect(toolTitle("run_terminal_command", { command: "npm test" })).toBe(
      "$ npm test",
    );
  });

  it("renders edit/write titles with the path", () => {
    expect(toolTitle("write_file", { path: "src/a.ts" })).toBe(
      "Write src/a.ts",
    );
    expect(toolTitle("str_replace", { path: "src/a.ts" })).toBe(
      "Edit src/a.ts",
    );
  });

  it("distinguishes apply_patch operations", () => {
    expect(
      toolTitle("apply_patch", {
        operation: { type: "create_file", path: "x.ts", diff: "" },
      }),
    ).toBe("Create x.ts");
    expect(
      toolTitle("apply_patch", {
        operation: { type: "delete_file", path: "x.ts" },
      }),
    ).toBe("Delete x.ts");
    expect(
      toolTitle("apply_patch", {
        operation: { type: "update_file", path: "x.ts", diff: "" },
      }),
    ).toBe("Edit x.ts");
  });

  it("summarises read/search tools", () => {
    expect(toolTitle("read_files", { paths: ["a.ts", "b.ts"] })).toBe(
      "Read a.ts, b.ts",
    );
    expect(
      toolTitle("read_files", { paths: ["a.ts", "b.ts", "c.ts", "d.ts"] }),
    ).toBe("Read a.ts +3 more");
    expect(toolTitle("code_search", { pattern: "TODO" })).toBe('Search "TODO"');
    expect(toolTitle("web_search", { query: "acp spec" })).toBe(
      'Web search "acp spec"',
    );
  });

  it("falls back to the tool name", () => {
    expect(toolTitle("mystery_tool", {})).toBe("mystery_tool");
  });
});

describe("toolLocations", () => {
  it("extracts paths from path-bearing tools", () => {
    expect(toolLocations("write_file", { path: "a.ts" })).toEqual([
      { path: "a.ts" },
    ]);
    expect(
      toolLocations("apply_patch", {
        operation: { type: "update_file", path: "a.ts" },
      }),
    ).toEqual([{ path: "a.ts" }]);
  });

  it("extracts each path from read_files", () => {
    expect(
      toolLocations("read_files", { paths: ["a.ts", "b.ts", "c.ts"] }),
    ).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]);
  });

  it("returns nothing for tools without a path", () => {
    expect(toolLocations("web_search", { query: "x" })).toEqual([]);
    expect(toolLocations("think_deeply", { thought: "x" })).toEqual([]);
  });
});

describe("toolScopeDescription", () => {
  it("prefers the path when available", () => {
    expect(toolScopeDescription("str_replace", { path: "a.ts" })).toBe("a.ts");
  });

  it("falls back to the primary argument", () => {
    expect(
      toolScopeDescription("run_terminal_command", { command: "rm -rf" }),
    ).toBe("rm -rf");
    expect(toolScopeDescription("code_search", { pattern: "X" })).toBe("X");
  });

  it("falls back to the tool name", () => {
    expect(toolScopeDescription("end_turn", {})).toBe("end_turn");
  });
});
