import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configHome, loadConfig, saveConfig } from "../src/config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cb-acp-cfg-"));
  process.env.CODEBUFF_ACP_HOME = home;
});

afterEach(() => {
  delete process.env.CODEBUFF_ACP_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("config", () => {
  it("returns an empty config when no file exists", async () => {
    expect(await loadConfig()).toEqual({});
  });

  it("round-trips an API key through disk", async () => {
    await saveConfig({ apiKey: "cb_12345" });
    expect(await loadConfig()).toEqual({ apiKey: "cb_12345" });
  });

  it("overwrites the key on re-save", async () => {
    await saveConfig({ apiKey: "old" });
    await saveConfig({ apiKey: "new" });
    expect((await loadConfig()).apiKey).toBe("new");
  });

  it("configHome respects CODEBUFF_ACP_HOME", () => {
    expect(configHome()).toBe(home);
  });
});
