#!/usr/bin/env node

/**
 * Stdio entry point for the Codebuff ACP agent.
 *
 * stdout carries ACP JSON-RPC messages to the client; everything else is
 * redirected to stderr so logs never corrupt the protocol stream.
 */

import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { runAcp } from "./agent.js";
import packageJson from "../package.json" with { type: "json" };

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

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
