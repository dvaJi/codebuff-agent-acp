#!/usr/bin/env node

/**
 * Stdio entry point for the Codebuff ACP agent.
 *
 * stdout carries ACP JSON-RPC messages to the client; everything else is
 * redirected to stderr so logs never corrupt the protocol stream.
 *
 * `--setup` runs the interactive Terminal Auth flow (collect + save the
 * Codebuff API key) instead of starting the ACP server.
 */

import { Readable, Writable } from "node:stream";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import * as acp from "@agentclientprotocol/sdk";

import { runAcp } from "./agent.js";
import { configHome, loadConfig, saveConfig } from "./config.js";
import packageJson from "../package.json" with { type: "json" };

if (process.argv.includes("--setup")) {
  runSetup().then(() => process.exit(0));
} else if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
} else {
  startServer();
}

/** Interactive Terminal Auth: prompt for the Codebuff API key and persist it. */
async function runSetup(): Promise<void> {
  const existing = await loadConfig();
  process.stderr.write("codebuff-agent-acp — setup\n");
  process.stderr.write(
    "Get your API key from https://codebuff.com (Profile → API Keys).\n",
  );
  if (existing.apiKey) {
    const masked = `${existing.apiKey.slice(0, 6)}…${existing.apiKey.slice(-4)}`;
    process.stderr.write(`Current key: ${masked}\n`);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question("Paste your Codebuff API key (Enter to keep current): ")
    ).trim();
    const key = answer || existing.apiKey;
    if (!key) {
      process.stderr.write("No key provided; nothing saved.\n");
      return;
    }
    await saveConfig({ apiKey: key });
    process.stderr.write(
      `✓ Saved to ${path.join(configHome(), "config.json")}\n`,
    );
  } finally {
    rl.close();
  }
}

function startServer(): void {
  // stdout is the protocol channel — divert all logging to stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const { connection, agent } = runAcp(stream);

  async function shutdown(): Promise<void> {
    agent.dispose();
    connection.close();
    process.exit(0);
  }

  connection.closed.then(shutdown).catch(shutdown);
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Keep the process alive while the connection is open.
  process.stdin.resume();
}
