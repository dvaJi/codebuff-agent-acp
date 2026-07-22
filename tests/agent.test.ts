import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import type { PrintModeEvent, RunState } from "@codebuff/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodebuffAcpAgent,
  registerAcpHandlers,
  type CodebuffClientLike,
} from "../src/agent.js";
import { loadConfig } from "../src/config.js";

/* -------------------------------------------------------------------------- */
/* Fake Codebuff client                                                        */
/* -------------------------------------------------------------------------- */

type RunOptions = Parameters<CodebuffClientLike["run"]>[0];

type ScriptItem =
  | { kind: "event"; event: PrintModeEvent }
  | { kind: "chunk"; chunk: string }
  | { kind: "block" }; // wait until the run's abort signal fires

/** Build a fake client that replays a scripted event stream on `run()`. */
function fakeClient(
  script: ScriptItem[],
  result: RunState,
): CodebuffClientLike {
  return {
    async run(options: RunOptions): Promise<RunState> {
      const handleEvent = options.handleEvent as
        | ((e: PrintModeEvent) => unknown)
        | undefined;
      const handleStreamChunk = options.handleStreamChunk as
        | ((c: string) => unknown)
        | undefined;
      const signal = options.signal as AbortSignal | undefined;

      for (const item of script) {
        if (signal?.aborted) break;
        if (item.kind === "chunk") {
          handleStreamChunk?.(item.chunk);
        } else if (item.kind === "event") {
          await handleEvent?.(item.event);
        } else {
          if (!signal) return result;
          if (signal.aborted) break;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
      }
      return result;
    },
  };
}

const DONE: RunState = {
  output: { type: "lastMessage", value: [{ type: "text", text: "done" }] },
};

/* -------------------------------------------------------------------------- */
/* In-process harness                                                          */
/* -------------------------------------------------------------------------- */

type PermissionBehavior = "allow" | "reject" | "cancel";

type ToolCallU = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }>;
type ToolCallUpdateU = Extract<
  acp.SessionUpdate,
  { sessionUpdate: "tool_call_update" }
>;

interface Harness {
  /** Client-side context for calling agent methods over the in-process link. */
  api: acp.ClientContext;
  updates: acp.SessionUpdate[];
  permissionRequests: acp.RequestPermissionRequest[];
  agent: CodebuffAcpAgent;
  close: () => void;
}

function setup(
  script: ScriptItem[],
  permission: PermissionBehavior = "allow",
): Harness {
  const agent = new CodebuffAcpAgent({
    clientFactory: () => fakeClient(script, DONE),
  });

  const agentApp = registerAcpHandlers(
    agent,
    acp.agent({ name: "codebuff-agent-acp" }),
  );

  const updates: acp.SessionUpdate[] = [];
  const permissionRequests: acp.RequestPermissionRequest[] = [];

  const clientApp = acp
    .client({ name: "test-client" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params.update);
    })
    .onRequest("session/request_permission", (ctx) => {
      permissionRequests.push(ctx.params);
      if (permission === "cancel") {
        return Promise.resolve({
          outcome: { outcome: "cancelled" as const },
        });
      }
      return Promise.resolve({
        outcome: {
          outcome: "selected" as const,
          optionId: permission === "reject" ? "reject" : "allow",
        },
      });
    });

  const conn = clientApp.connect(agentApp);
  return {
    api: conn.agent,
    updates,
    permissionRequests,
    agent,
    close: () => conn.close(),
  };
}

/** Drive a fresh session through one prompt and return the observed updates. */
async function runTurn(
  api: acp.ClientContext,
  prompt: string,
): Promise<{ sessionId: string; result: acp.PromptResponse }> {
  const { sessionId } = await api.request(acp.methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const result = await api.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  return { sessionId, result };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cb-acp-e2e-"));
  process.env.CODEBUFF_ACP_HOME = home;
});

afterEach(() => {
  delete process.env.CODEBUFF_ACP_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("initialization", () => {
  it("advertises capabilities and agent info", async () => {
    const { api, close } = setup([]);
    const res = await api.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities?.loadSession).toBe(true);
    expect(res.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(res.agentInfo?.name).toBe("codebuff-agent-acp");
    close();
  });

  it("advertises a terminal auth method that runs --setup", async () => {
    const { api, close } = setup([]);
    const init = await api.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    type TerminalAuth = Extract<acp.AuthMethod, { type: "terminal" }>;
    const terminal = init.authMethods?.find(
      (m): m is TerminalAuth => (m as { type?: string }).type === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal?.id).toBe("codebuff-api-key");
    expect(terminal?.args).toContain("--setup");
    close();
  });

  it("persists an API key passed via authenticate", async () => {
    const { api, close } = setup([]);
    await api.request(acp.methods.agent.authenticate, {
      methodId: "codebuff-api-key",
      _meta: { codebuff: { apiKey: "cb_persisted" } },
    });
    expect(await loadConfig()).toEqual({ apiKey: "cb_persisted" });
    close();
  });
});

describe("a streaming turn", () => {
  it("emits agent_message_chunk for each streamed chunk and ends the turn", async () => {
    const { api, updates, close } = setup([
      { kind: "chunk", chunk: "Hello " },
      { kind: "chunk", chunk: "world" },
    ]);

    const { result } = await runTurn(api, "hi");
    const chunks = updates.filter(
      (u) => u.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks).toHaveLength(2);
    expect((chunks[0].content as { text: string }).text).toBe("Hello ");
    expect((chunks[1].content as { text: string }).text).toBe("world");
    expect(chunks[0].messageId).toBe(chunks[1].messageId);
    expect(result.stopReason).toBe("end_turn");
    close();
  });

  it("falls back to the run output text when nothing streamed", async () => {
    const { api, updates, close } = setup([]);
    await runTurn(api, "hi");
    const chunks = updates.filter(
      (u) => u.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    expect((chunks[0].content as { text: string }).text).toBe("done");
    close();
  });

  it("emits agent_message_chunk from a text event", async () => {
    const { api, updates, close } = setup([
      { kind: "event", event: { type: "text", text: "hello there" } },
    ]);
    await runTurn(api, "hi");
    const chunks = updates.filter(
      (u) => u.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    expect((chunks[0].content as { text: string }).text).toBe("hello there");
    close();
  });

  it("does not duplicate when a turn is streamed then re-delivered as a text event", async () => {
    const { api, updates, close } = setup([
      { kind: "chunk", chunk: "He" },
      { kind: "chunk", chunk: "llo" },
      { kind: "event", event: { type: "text", text: "Hello" } },
    ]);
    await runTurn(api, "hi");
    const chunks = updates.filter(
      (u) => u.sessionUpdate === "agent_message_chunk",
    );
    // Only the two streamed chunks; the trailing consolidated `text` event is
    // suppressed because the message was already delivered token-by-token.
    expect(chunks.map((c) => (c.content as { text: string }).text)).toEqual([
      "He",
      "llo",
    ]);
    close();
  });

  it("streams reasoning as agent_thought_chunk", async () => {
    const { api, updates, close } = setup([
      {
        kind: "event",
        event: {
          type: "reasoning_delta",
          text: "let me think",
          runId: "r1",
          ancestorRunIds: [],
        },
      },
    ]);
    await runTurn(api, "hi");
    const thoughts = updates.filter(
      (u) => u.sessionUpdate === "agent_thought_chunk",
    );
    expect(thoughts).toHaveLength(1);
    expect((thoughts[0].content as { text: string }).text).toBe("let me think");
    close();
  });
});

describe("tool calls", () => {
  it("reports a read tool as pending then completed", async () => {
    const { api, updates, close } = setup([
      {
        kind: "event",
        event: {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "read_files",
          input: { paths: ["src/a.ts"] },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_result",
          toolCallId: "c1",
          toolName: "read_files",
          output: [{ type: "json", value: { content: "file body" } }],
        },
      },
    ]);
    await runTurn(api, "read it");

    const calls = updates.filter(
      (u): u is ToolCallU => u.sessionUpdate === "tool_call",
    );
    const completes = updates.filter(
      (u): u is ToolCallUpdateU => u.sessionUpdate === "tool_call_update",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("read");
    expect(calls[0].status).toBe("pending");
    expect(calls[0].locations).toEqual([{ path: "src/a.ts" }]);
    expect(completes).toHaveLength(1);
    expect(completes[0].status).toBe("completed");
    close();
  });

  it("requests permission for a shell tool and completes when allowed", async () => {
    const { api, updates, permissionRequests, close } = setup(
      [
        {
          kind: "event",
          event: {
            type: "tool_call",
            toolCallId: "c_sh",
            toolName: "run_terminal_command",
            input: { command: "npm test" },
          },
        },
        {
          kind: "event",
          event: {
            type: "tool_result",
            toolCallId: "c_sh",
            toolName: "run_terminal_command",
            output: [{ type: "json", value: { exitCode: 0 } }],
          },
        },
      ],
      "allow",
    );
    await runTurn(api, "run tests");

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].toolCall.kind).toBe("execute");
    expect(permissionRequests[0].options.map((o) => o.optionId)).toStrictEqual([
      "allow",
      "allow_always",
      "reject",
      "reject_always",
    ]);

    const completes = updates.filter(
      (u): u is ToolCallUpdateU => u.sessionUpdate === "tool_call_update",
    );
    expect(completes.at(-1)?.status).toBe("completed");
    close();
  });

  it("marks a tool call failed when the user rejects it", async () => {
    const { api, updates, close } = setup(
      [
        {
          kind: "event",
          event: {
            type: "tool_call",
            toolCallId: "c_w",
            toolName: "write_file",
            input: { path: "out.txt", content: "x" },
          },
        },
        {
          kind: "event",
          event: {
            type: "tool_result",
            toolCallId: "c_w",
            toolName: "write_file",
            output: [{ type: "json", value: { message: "written" } }],
          },
        },
      ],
      "reject",
    );
    await runTurn(api, "write");

    const completes = updates.filter(
      (u): u is ToolCallUpdateU => u.sessionUpdate === "tool_call_update",
    );
    // Rejected → failed; the later tool_result is suppressed (no completed).
    expect(completes.at(-1)?.status).toBe("failed");
    close();
  });
});

describe("sub-agents and plan", () => {
  it("surfaces a sub-agent as a nested tool call", async () => {
    const { api, updates, close } = setup([
      {
        kind: "event",
        event: {
          type: "subagent_start",
          agentId: "file-picker",
          agentType: "file_picker",
          displayName: "File Picker",
          onlyChild: true,
        },
      },
      {
        kind: "event",
        event: {
          type: "subagent_finish",
          agentId: "file-picker",
          agentType: "file_picker",
          displayName: "File Picker",
          onlyChild: true,
        },
      },
    ]);
    await runTurn(api, "go");

    const calls = updates.filter(
      (u): u is ToolCallU => u.sessionUpdate === "tool_call",
    );
    const completes = updates.filter(
      (u): u is ToolCallUpdateU => u.sessionUpdate === "tool_call_update",
    );
    expect(calls[0].toolCallId).toBe("subagent:file-picker");
    expect(calls[0].title).toContain("File Picker");
    expect(completes.at(-1)?.status).toBe("completed");
    close();
  });

  it("mirrors write_todos as an ACP plan update", async () => {
    const { api, updates, close } = setup([
      {
        kind: "event",
        event: {
          type: "tool_call",
          toolCallId: "c_plan",
          toolName: "write_todos",
          input: {
            todos: [
              { task: "step one", completed: false },
              { task: "step two", completed: true },
            ],
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_result",
          toolCallId: "c_plan",
          toolName: "write_todos",
          output: [{ type: "json", value: { message: "ok" } }],
        },
      },
    ]);
    await runTurn(api, "plan");

    const plans = updates.filter((u) => u.sessionUpdate === "plan");
    expect(plans).toHaveLength(1);
    expect(
      (plans[0] as { entries: { content: string; status: string }[] }).entries,
    ).toMatchObject([
      { content: "step one", status: "in_progress" },
      { content: "step two", status: "completed" },
    ]);
    close();
  });
});

describe("error handling and cancellation", () => {
  it("streams a friendly error and still ends the turn", async () => {
    const { api, updates, close } = setup([
      { kind: "event", event: { type: "error", message: "kaboom" } },
    ]);
    const { result } = await runTurn(api, "hi");
    const chunks = updates.filter(
      (u) => u.sessionUpdate === "agent_message_chunk",
    );
    const last = chunks.at(-1);
    expect(
      (last?.content as { text: string } | undefined)?.text ?? "",
    ).toContain("kaboom");
    expect(result.stopReason).toBe("end_turn");
    close();
  });

  it("cancels a blocked turn via session/cancel", async () => {
    const { api, close } = setup([{ kind: "block" }]);
    const { sessionId } = await api.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });

    const promptPromise = api.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "long" }],
    });
    // Let the turn reach the blocking step.
    await new Promise((r) => setTimeout(r, 20));
    await api.notify(acp.methods.agent.session.cancel, { sessionId });

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
    close();
  });
});

describe("session persistence", () => {
  it("lists and resumes a persisted session", async () => {
    const { api, close } = setup([{ kind: "chunk", chunk: "hi" }]);
    const { sessionId } = await runTurn(api, "first");

    const list = await api.request(acp.methods.agent.session.list, {});
    expect(list.sessions.map((s) => s.sessionId)).toContain(sessionId);

    const resumed = await api.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: process.cwd(),
    });
    expect(resumed).toBeDefined();
    close();
  });
});
