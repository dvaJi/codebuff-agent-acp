/**
 * Disk-backed session store.
 *
 * Codebuff's resumable conversation state is the JSON `RunState` returned by
 * `client.run()`. We persist it (plus a little metadata) per session so that
 * ACP clients can reopen, list, fork, and resume threads across restarts —
 * mirroring what `claude-agent-acp` does with Claude's session files.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { RunState } from "@codebuff/sdk";
import { configHome } from "./config.js";

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  /** Best-effort title derived from the first user prompt. */
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** Codebuff resumable state. Absent until the first completed turn. */
  runState?: RunState;
}

/**
 * Where session files live. Read lazily on each call so tests (and changing
 * `CODEBUFF_ACP_HOME`) are respected without a process restart.
 */
function storeDir(): string {
  return path.join(configHome(), "sessions");
}

function fileFor(sessionId: string): string {
  // Guard against path traversal — session ids are opaque to us.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(storeDir(), `${safe}.json`);
}

async function ensureStore(): Promise<void> {
  await fs.mkdir(storeDir(), { recursive: true });
}

export async function saveSession(record: SessionRecord): Promise<void> {
  await ensureStore();
  record.updatedAt = Date.now();
  await fs.writeFile(fileFor(record.sessionId), JSON.stringify(record), "utf8");
}

export async function loadSessionRecord(
  sessionId: string,
): Promise<SessionRecord | undefined> {
  try {
    const raw = await fs.readFile(fileFor(sessionId), "utf8");
    return JSON.parse(raw) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await fs.unlink(fileFor(sessionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function listSessionRecords(): Promise<SessionRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(storeDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(storeDir(), entry), "utf8");
      records.push(JSON.parse(raw) as SessionRecord);
    } catch {
      // Skip corrupt files rather than failing the whole listing.
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Truncate a prompt into a readable session title. */
export function titleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "New session";
  return cleaned.length > 80 ? cleaned.slice(0, 79) + "…" : cleaned;
}
