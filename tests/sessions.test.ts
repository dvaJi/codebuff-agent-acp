import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteSession,
  listSessionRecords,
  loadSessionRecord,
  saveSession,
  titleFromPrompt,
  type SessionRecord,
} from "../src/sessions.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cb-acp-home-"));
  process.env.CODEBUFF_ACP_HOME = home;
});

afterEach(() => {
  delete process.env.CODEBUFF_ACP_HOME;
  rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "s_test1",
    cwd: "/tmp/proj",
    title: "hello world",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("saveSession / loadSessionRecord", () => {
  it("round-trips a record through disk", async () => {
    await saveSession(record());
    const loaded = await loadSessionRecord("s_test1");
    expect(loaded).toBeDefined();
    expect(loaded?.sessionId).toBe("s_test1");
    expect(loaded?.cwd).toBe("/tmp/proj");
    expect(loaded?.title).toBe("hello world");
  });

  it("stamps the mtime on each save", async () => {
    const before = Date.now();
    await saveSession(record());
    const first = await loadSessionRecord("s_test1");
    expect(first?.updatedAt).toBeGreaterThanOrEqual(before);

    await new Promise((r) => setTimeout(r, 5));
    await saveSession(record());
    const second = await loadSessionRecord("s_test1");
    expect(second?.updatedAt).toBeGreaterThan(first!.updatedAt);
  });

  it("returns undefined for a missing session", async () => {
    expect(await loadSessionRecord("does-not-exist")).toBeUndefined();
  });

  it("persists a RunState for resume", async () => {
    const runState = {
      output: {
        type: "lastMessage" as const,
        value: [{ type: "text", text: "hi" }],
      },
    };
    await saveSession(record({ runState }));
    const loaded = await loadSessionRecord("s_test1");
    expect(loaded?.runState).toEqual(runState);
  });
});

describe("listSessionRecords", () => {
  it("lists sessions sorted by most-recent first", async () => {
    // saveSession stamps `now`, so saving in chronological order yields
    // ascending mtimes — the list must come back newest-first.
    await saveSession(record({ sessionId: "old" }));
    await new Promise((r) => setTimeout(r, 5));
    await saveSession(record({ sessionId: "mid" }));
    await new Promise((r) => setTimeout(r, 5));
    await saveSession(record({ sessionId: "new" }));

    const list = await listSessionRecords();
    expect(list.map((r) => r.sessionId)).toEqual(["new", "mid", "old"]);
  });

  it("returns an empty array before any sessions exist", async () => {
    expect(await listSessionRecords()).toEqual([]);
  });
});

describe("deleteSession", () => {
  it("removes a record", async () => {
    await saveSession(record());
    await deleteSession("s_test1");
    expect(await loadSessionRecord("s_test1")).toBeUndefined();
  });

  it("is a no-op for a missing session", async () => {
    await expect(deleteSession("nope")).resolves.toBeUndefined();
  });

  it("ignores path-traversal-shaped ids", async () => {
    await saveSession(record({ sessionId: "s_safe" }));
    // A crafted id must not escape the store directory.
    await deleteSession("../../etc_passwd");
    expect(await loadSessionRecord("s_safe")).toBeDefined();
  });
});

describe("titleFromPrompt", () => {
  it("uses the prompt text", () => {
    expect(titleFromPrompt("Add a login page")).toBe("Add a login page");
  });

  it("collapses whitespace", () => {
    expect(titleFromPrompt("Add\n\n  a   login")).toBe("Add a login");
  });

  it("truncates long prompts with an ellipsis", () => {
    const long = "x".repeat(120);
    const title = titleFromPrompt(long);
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("has a fallback for empty input", () => {
    expect(titleFromPrompt("   ")).toBe("New session");
  });
});
