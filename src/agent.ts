/**
 * Codebuff → ACP adapter.
 *
 * Each ACP session owns one `CodebuffClient`. A `session/prompt` is a single
 * `client.run()`; Codebuff's streamed events are translated on the fly into
 * ACP `session/update` notifications (agent message chunks, tool calls,
 * sub-agent nesting, reasoning, and plan/todos), and permission prompts are
 * routed back to the client via `session/request_permission`.
 *
 * Resumable `RunState` is persisted to disk so sessions survive restarts and
 * can be listed / resumed / forked.
 */

import * as crypto from "node:crypto";

import * as acp from "@agentclientprotocol/sdk";
import {
  CodebuffClient,
  type PrintModeEvent,
  type RunState,
} from "@codebuff/sdk";

import { promptToCodebuff, textFromOutput } from "./converters.js";
import {
  isGatedTool,
  toolKind,
  toolLocations,
  toolScopeDescription,
  toolTitle,
} from "./mapping.js";
import {
  deleteSession,
  listSessionRecords,
  loadSessionRecord,
  saveSession,
  titleFromPrompt,
  type SessionRecord,
} from "./sessions.js";

const VERSION = "0.1.0";
const DEFAULT_AGENT_ID = process.env.CODEBUFF_AGENT ?? "base";

/** The slice of `CodebuffClient` the adapter actually depends on. Keeping the
 *  dependency narrow lets tests inject a fake client. */
export type CodebuffClientLike = Pick<CodebuffClient, "run">;

/** Active in-memory session: one Codebuff client + resumable state. */
interface Session {
  sessionId: string;
  cwd: string;
  createdAt: number;
  /** Built lazily on first prompt — constructing it requires an API key. */
  client?: CodebuffClientLike;
  previousRun?: RunState;
  title: string | null;
  abortController?: AbortController;
}

/** A tool call the user rejected via the permission prompt. */
type PermissionCache = {
  rejected: Set<string>;
  allowAlways: Set<string>;
};

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Options for constructing a {@link CodebuffAcpAgent}. */
export interface CodebuffAcpAgentOptions {
  /**
   * Factory used to build a Codebuff client per session. Tests inject a fake
   * here to drive the event-mapping logic without an API key or network.
   */
  clientFactory?: (opts: { apiKey: string; cwd: string }) => CodebuffClientLike;
}

export class CodebuffAcpAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly clientFactory: (opts: {
    apiKey: string;
    cwd: string;
  }) => CodebuffClientLike;
  private apiKey = process.env.CODEBUFF_API_KEY ?? "";

  constructor(opts: CodebuffAcpAgentOptions = {}) {
    this.clientFactory =
      opts.clientFactory ??
      ((o) => new CodebuffClient(o) as CodebuffClientLike);
  }

  /** ---- lifecycle handlers ---- */

  async initialize(
    _params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: { http: false, sse: false, acp: false },
        sessionCapabilities: {
          list: {},
          delete: {},
          resume: {},
          close: {},
          fork: {},
        },
      },
      agentInfo: {
        name: "codebuff-agent-acp",
        title: "Codebuff",
        version: VERSION,
      },
      authMethods: [],
    };
  }

  async authenticate(
    params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse | void> {
    const key = (params as { _meta?: { codebuff?: { apiKey?: string } } })._meta
      ?.codebuff?.apiKey;
    if (key) this.apiKey = key;
    return {};
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = newId("s");
    const cwd = params.cwd ?? process.cwd();
    const createdAt = Date.now();
    const session: Session = { sessionId, cwd, createdAt, title: null };
    this.sessions.set(sessionId, session);
    await saveSession({
      sessionId,
      cwd,
      title: null,
      createdAt,
      updatedAt: createdAt,
    });
    return { sessionId };
  }

  /** ---- the main turn ---- */

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    ctx: { signal: AbortSignal },
  ): Promise<acp.PromptResponse> {
    const session = this.requireSession(params.sessionId);
    const { prompt: promptString, content } = promptToCodebuff(params.prompt);

    const controller = new AbortController();
    session.abortController = controller;
    const onParentAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    let aborted = false;
    controller.signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );

    const perm: PermissionCache = {
      rejected: new Set(),
      allowAlways: new Set(),
    };
    const subagentMessageIds = new Map<string, string>();
    const mainMessageId = newId("m");
    const thoughtMessageId = newId("th");
    let emittedAnyText = false;
    // True once the main agent's text has been delivered token-by-token via
    // handleStreamChunk. When set, subsequent `text` events (the consolidated
    // message) are suppressed to avoid duplicating already-streamed content.
    let streamedText = false;

    const notify = (update: acp.SessionUpdate): Promise<void> =>
      client.notify(acp.methods.client.session.update, {
        sessionId: session.sessionId,
        update,
      });

    const handleEvent = async (event: PrintModeEvent): Promise<void> => {
      switch (event.type) {
        case "text":
          // Codebuff's base agent delivers assistant text through these `text`
          // events (token streaming via handleStreamChunk doesn't always fire).
          // Emit each as a chunk so the message appears as it's produced rather
          // than only at turn-end. Skip when we already streamed this message
          // token-by-token, to avoid duplicating the same content.
          if (streamedText) return;
          emittedAnyText = true;
          await notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.text },
            messageId: mainMessageId,
          });
          return;

        case "reasoning_delta":
          await notify({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.text },
            messageId: thoughtMessageId,
          });
          return;

        case "tool_call": {
          const { toolCallId, toolName, input, agentId, parentAgentId } = event;
          const kind = toolKind(toolName);
          const title = toolTitle(toolName, input ?? {});
          const locations = toolLocations(toolName, input ?? {});
          const meta: Record<string, unknown> = {};
          if (agentId) meta.agentId = agentId;
          if (parentAgentId)
            meta.parentToolCallId = `subagent:${parentAgentId}`;

          await notify({
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            kind,
            status: "pending",
            locations,
            rawInput: input,
            _meta: Object.keys(meta).length ? { codebuff: meta } : undefined,
          });

          // Surface the model's own plan as an ACP plan update.
          if (toolName === "write_todos" && Array.isArray(input?.todos)) {
            await notify({
              sessionUpdate: "plan",
              entries: (
                input.todos as Array<{ task?: string; completed?: boolean }>
              )
                .filter((t) => typeof t.task === "string")
                .map((t) => ({
                  content: t.task as string,
                  priority: "medium" as const,
                  status: t.completed
                    ? ("completed" as const)
                    : ("in_progress" as const),
                })),
            });
          }

          if (isGatedTool(toolName)) {
            const scope = toolScopeDescription(toolName, input ?? {});
            const response = await client.request<
              acp.RequestPermissionResponse,
              acp.RequestPermissionRequest
            >(acp.methods.client.session.requestPermission, {
              sessionId: session.sessionId,
              toolCall: {
                toolCallId,
                title,
                kind,
                status: "pending",
                locations,
                rawInput: input,
              },
              options: [
                {
                  optionId: "allow",
                  name: `Allow (${scope})`,
                  kind: "allow_once",
                },
                {
                  optionId: "allow_always",
                  name: "Always allow this tool",
                  kind: "allow_always",
                },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
                {
                  optionId: "reject_always",
                  name: "Always reject this tool",
                  kind: "reject_always",
                },
              ],
            });

            if (response.outcome.outcome === "cancelled") {
              controller.abort();
              return;
            }
            if (
              response.outcome.outcome === "selected" &&
              String(response.outcome.optionId).startsWith("reject")
            ) {
              perm.rejected.add(toolCallId);
              await notify({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "failed",
                rawOutput: { rejected: true },
              });
            } else if (
              response.outcome.outcome === "selected" &&
              response.outcome.optionId === "allow_always"
            ) {
              perm.allowAlways.add(toolName);
            }
          }
          return;
        }

        case "tool_result": {
          if (perm.rejected.has(event.toolCallId)) return;
          const rawOutput = (event.output ?? []).map(
            (o: {
              type: string;
              value?: unknown;
              data?: string;
              mediaType?: string;
            }) =>
              o.type === "json"
                ? o.value
                : { media: o.data, mediaType: o.mediaType },
          );
          await notify({
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "completed",
            rawOutput,
          });
          return;
        }

        case "subagent_start": {
          const toolCallId = `subagent:${event.agentId}`;
          await notify({
            sessionUpdate: "tool_call",
            toolCallId,
            title: event.displayName ?? event.agentType ?? "Sub-agent",
            kind: "other",
            status: "pending",
            locations: [],
            rawInput: {
              agentType: event.agentType,
              prompt: event.prompt,
              params: event.params,
            },
            _meta: {
              codebuff: {
                subagent: true,
                agentId: event.agentId,
                parentAgentId: event.parentAgentId,
              },
            },
          });
          return;
        }

        case "subagent_finish": {
          await notify({
            sessionUpdate: "tool_call_update",
            toolCallId: `subagent:${event.agentId}`,
            status: "completed",
            rawOutput: { agentType: event.agentType },
          });
          return;
        }

        case "error":
          emittedAnyText = true;
          await notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `⚠️ ${event.message}` },
            messageId: mainMessageId,
          });
          return;

        case "start":
        case "finish":
        case "download":
          return;

        default:
          return;
      }
    };

    const handleStreamChunk = (
      chunk:
        | string
        | {
            type: "subagent_chunk";
            agentId: string;
            agentType: string;
            chunk: string;
          }
        | { type: "reasoning_chunk"; agentId: string; chunk: string },
    ): void => {
      if (typeof chunk === "string") {
        if (chunk) {
          streamedText = true;
          emittedAnyText = true;
          void notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
            messageId: mainMessageId,
          });
        }
        return;
      }
      if (chunk.type === "subagent_chunk") {
        const messageId = subagentMessageIds.get(chunk.agentId) ?? newId("sm");
        subagentMessageIds.set(chunk.agentId, messageId);
        void notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk.chunk },
          messageId,
          _meta: {
            codebuff: {
              subagentAgentId: chunk.agentId,
              agentType: chunk.agentType,
            },
          },
        });
        return;
      }
      // reasoning_chunk: surfaced via the reasoning_delta event instead.
    };

    let result: RunState;
    try {
      // Lazily construct the Codebuff client on first prompt so that sessions
      // can be created without an API key (the error surfaces only when the
      // user actually sends a message).
      const cb = (session.client ??= this.buildClient(session.cwd));
      result = await cb.run({
        agent: DEFAULT_AGENT_ID,
        prompt: promptString,
        content: content.length > 0 ? content : undefined,
        previousRun: session.previousRun,
        signal: controller.signal,
        handleEvent,
        handleStreamChunk,
      } as Parameters<CodebuffClientLike["run"]>[0]);
    } catch (err) {
      ctx.signal.removeEventListener("abort", onParentAbort);
      if (aborted || controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      const message = err instanceof Error ? err.message : String(err);
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `⚠️ Codebuff error: ${message}` },
        messageId: mainMessageId,
      });
      return { stopReason: "end_turn" };
    }
    ctx.signal.removeEventListener("abort", onParentAbort);

    if (aborted || controller.signal.aborted) {
      return { stopReason: "cancelled" };
    }

    // Fallback for the case where the run produced output but emitted neither
    // stream chunks nor `text` events (so nothing was shown during the turn).
    if (!emittedAnyText) {
      const text = textFromOutput(result.output);
      if (text) {
        await notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          messageId: mainMessageId,
        });
      }
    }

    // Persist resumable state.
    session.previousRun = result;
    if (!session.title) session.title = titleFromPrompt(promptString);
    const record: SessionRecord = {
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      runState: result,
    };
    await saveSession(record).catch((err) =>
      console.error("Failed to persist session:", err),
    );

    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.abortController?.abort();
  }

  /** ---- session management (backed by the disk store) ---- */

  async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    const record = await loadSessionRecord(params.sessionId);
    if (!record) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${params.sessionId} not found`,
      );
    }

    const cwd = params.cwd ?? record.cwd;
    const session: Session = {
      sessionId: record.sessionId,
      cwd,
      createdAt: record.createdAt ?? Date.now(),
      previousRun: record.runState,
      title: record.title,
    };
    this.sessions.set(session.sessionId, session);

    // Best-effort replay of prior conversation as agent/user message chunks.
    await this.replayHistory(session, client);

    return {};
  }

  async listSessions(
    _params: acp.ListSessionsRequest,
  ): Promise<acp.ListSessionsResponse> {
    const records = await listSessionRecords();
    return {
      sessions: records.map((r) => ({
        sessionId: r.sessionId,
        cwd: r.cwd,
        title: r.title,
        updatedAt: new Date(r.updatedAt).toISOString(),
      })),
    };
  }

  async forkSession(
    params: acp.ForkSessionRequest,
  ): Promise<acp.ForkSessionResponse> {
    const parent =
      this.sessions.get(params.sessionId) ??
      (await loadSessionRecord(params.sessionId)) ??
      undefined;
    if (!parent) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${params.sessionId} not found`,
      );
    }
    const cwd = "cwd" in parent ? parent.cwd : process.cwd();
    const previousRun =
      "previousRun" in parent ? parent.previousRun : undefined;
    const createdAt = "createdAt" in parent ? parent.createdAt : Date.now();
    const title = "title" in parent ? parent.title : null;

    const sessionId = newId("s");
    const session: Session = {
      sessionId,
      cwd,
      createdAt: Date.now(),
      previousRun: previousRun
        ? (structuredCloneSafe(previousRun) as RunState)
        : undefined,
      title: title ? `${title} (fork)` : null,
    };
    this.sessions.set(sessionId, session);
    await saveSession({
      sessionId,
      cwd,
      title: session.title,
      createdAt,
      updatedAt: Date.now(),
      runState: session.previousRun,
    });
    return { sessionId };
  }

  async resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    const record = await loadSessionRecord(params.sessionId);
    if (!record) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${params.sessionId} not found`,
      );
    }
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      cwd: record.cwd,
      createdAt: record.createdAt ?? Date.now(),
      previousRun: record.runState,
      title: record.title,
    });
    return {};
  }

  async closeSession(
    _params: acp.CloseSessionRequest,
  ): Promise<acp.CloseSessionResponse> {
    // State is already persisted on each turn; just drop the in-memory client.
    return {};
  }

  async deleteSession(
    params: acp.DeleteSessionRequest,
  ): Promise<acp.DeleteSessionResponse | void> {
    this.sessions.delete(params.sessionId);
    await deleteSession(params.sessionId);
    return {};
  }

  async setSessionMode(
    _params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    // Mode switching isn't exposed by the Codebuff SDK; accept silently.
    return {};
  }

  /** ---- internals ---- */

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${sessionId} not found`,
      );
    }
    return session;
  }

  private buildClient(cwd: string): CodebuffClientLike {
    return this.clientFactory({ apiKey: this.apiKey, cwd });
  }

  private async replayHistory(
    session: Session,
    client: acp.AgentContext,
  ): Promise<void> {
    const history = session.previousRun?.sessionState?.mainAgentState
      ?.messageHistory as
      | Array<{
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>
      | undefined;
    if (!Array.isArray(history)) return;

    for (const message of history) {
      const text = (message.content ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
      if (!text) continue;
      const isAgent = message.role === "assistant";
      await client.notify(acp.methods.client.session.update, {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: isAgent ? "agent_message_chunk" : "user_message_chunk",
          content: { type: "text", text },
        },
      });
    }
  }

  /** Abort any in-flight turns; called on shutdown. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
    }
  }
}

/** structuredClone with a JSON fallback for older runtimes / non-cloneable values. */
function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Register every ACP handler on an `AgentApp`. Exported so tests can wire the
 *  same handlers onto an in-process app driven by a fake client. */
export function registerAcpHandlers(
  agent: CodebuffAcpAgent,
  app: ReturnType<typeof acp.agent>,
): ReturnType<typeof acp.agent> {
  return app
    .onRequest("initialize", (ctx) => agent.initialize(ctx.params))
    .onRequest("authenticate", (ctx) => agent.authenticate(ctx.params))
    .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
    .onRequest("session/load", (ctx) =>
      agent.loadSession(ctx.params, ctx.client),
    )
    .onRequest("session/list", (ctx) => agent.listSessions(ctx.params))
    .onRequest("session/fork", (ctx) => agent.forkSession(ctx.params))
    .onRequest("session/resume", (ctx) => agent.resumeSession(ctx.params))
    .onRequest("session/close", (ctx) => agent.closeSession(ctx.params))
    .onRequest("session/delete", (ctx) => agent.deleteSession(ctx.params))
    .onRequest("session/set_mode", (ctx) => agent.setSessionMode(ctx.params))
    .onRequest("session/prompt", (ctx) =>
      agent.prompt(ctx.params, ctx.client, ctx),
    )
    .onNotification("session/cancel", (ctx) => agent.cancel(ctx.params));
}

/** Wire the agent onto an ACP AgentApp over the given stream. */
export function runAcp(stream: acp.Stream): {
  connection: acp.AgentConnection;
  app: ReturnType<typeof acp.agent>;
  agent: CodebuffAcpAgent;
} {
  const agent = new CodebuffAcpAgent();
  const app = registerAcpHandlers(
    agent,
    acp.agent({ name: "codebuff-agent-acp" }),
  );
  const connection = app.connect(stream);
  return { connection, app, agent };
}
