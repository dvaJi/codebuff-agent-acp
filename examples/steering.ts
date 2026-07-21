/**
 * Example: drive THIS agent (codebuff-agent-acp) as a subprocess over ACP,
 * modelled on claude-agent-acp's steering example.
 *
 * It launches our built `dist/index.js`, opens a session, starts a deliberately
 * long-running prompt, streams the agent's output, auto-approves any permission
 * prompts, and — once output is flowing — attempts a mid-turn `_session/steering`
 * request.
 *
 * NOTE ON STEERING: `_session/steering` is a Claude-specific extension. This
 * adapter does NOT implement it (Codebuff's SDK exposes no way to inject a
 * message into an in-flight `client.run()`), so the steer request is expected to
 * be rejected with method-not-found. The rest of the script is a full local
 * integration test: spawn → initialize → session → prompt → stream → stopReason.
 *
 * Run (build first so `dist/index.js` exists):
 *
 *   npm run build
 *   CODEBUFF_API_KEY=cb_...  npx tsx examples/steering.ts
 *
 * Without a key the agent will still run, emitting a friendly error chunk and
 * `stopReason: end_turn` — useful as a no-credits smoke test.
 *
 * Override the prompts with the EXAMPLE_PROMPT / EXAMPLE_STEER env vars. CWD
 * defaults to the repo root.
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  client as acpClient,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

/** The steering extension method, per the ACP steering wire protocol. */
const STEERING_METHOD = "_session/steering";

type SteeringRequest = {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
};

type SteeringResponse = {
  outcome: "injected" | "startedNewTurn";
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AGENT_ENTRY =
  process.env.AGENT_ENTRY ?? path.join(repoRoot, "dist", "index.js");
const CWD = process.env.CWD ?? repoRoot;

// NOTE: avoid the `PROMPT` env var — on Windows it holds the shell prompt
// format (e.g. `$P$G`), which would clobber this default.
const PROMPT =
  process.env.EXAMPLE_PROMPT ??
  "Count slowly from 1 to 30, one number per line, with a short sentence of " +
    "commentary after each. Do not stop early.";
const STEER =
  process.env.EXAMPLE_STEER ??
  "Actually stop counting and instead reply with exactly one line: STEERED-OK";

function log(msg: string) {
  process.stderr.write(`\x1b[2m[client]\x1b[0m ${msg}\n`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const child = spawn(process.execPath, [AGENT_ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  child.on("error", (err) => {
    log(`failed to spawn agent (${AGENT_ENTRY}): ${err}`);
    process.exit(1);
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );

  // Resolves the first time the agent streams assistant text.
  let signalFirstOutput = () => {};
  const firstOutput = new Promise<void>(
    (resolve) => (signalFirstOutput = resolve),
  );

  const connection = acpClient({ name: "steering-example" })
    .onNotification(methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        process.stdout.write(update.content.text);
        signalFirstOutput();
      }
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const options = ctx.params.options;
      const option = options.find((o) => o.kind === "allow_once") ?? options[0];
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    })
    .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
    .onRequest(methods.client.fs.writeTextFile, () => ({}))
    .connect(stream);

  const agent = connection.agent;

  // 1. Initialize. Our adapter does not advertise steering, so this prints false.
  const init = await agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const meta = init._meta as {
    steering?: { supported?: boolean };
  } | null;
  const steeringSupported = meta?.steering?.supported === true;
  log(`agent advertises steering: ${steeringSupported}`);
  if (!steeringSupported) {
    log(
      "adapter does not support steering; the request below will be rejected.",
    );
  }

  // 2. Open a session.
  const { sessionId } = await agent.request(methods.agent.session.new, {
    cwd: CWD,
    mcpServers: [],
  });
  log(`session: ${sessionId}`);

  // 3. Start a long turn WITHOUT awaiting — we want it in flight.
  log(`prompt: ${PROMPT}`);
  process.stdout.write("\n----- agent output -----\n");
  const turn = agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });

  // 4. Once output is flowing, attempt the steer.
  await Promise.race([firstOutput, delay(5000)]);
  await delay(1000);

  process.stdout.write("\n");
  log(`steer: ${STEER}`);
  const steerRequest: SteeringRequest = {
    sessionId,
    prompt: [{ type: "text", text: STEER }],
  };
  try {
    const result = await agent.request<SteeringResponse>(
      STEERING_METHOD,
      steerRequest,
    );
    log(`steer outcome: ${result.outcome}`);
  } catch (err) {
    log(`steer rejected (expected): ${err}`);
  }

  // 5. Await the turn and report why it stopped.
  const response = await turn.catch((err: unknown) => {
    log(`turn error: ${err}`);
    return undefined;
  });
  if (response) log(`turn stopReason: ${response.stopReason}`);
  await delay(1000);
  process.stdout.write("\n----- end of agent output -----\n");

  connection.close();
  child.kill();
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
