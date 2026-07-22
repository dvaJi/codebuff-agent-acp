# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-07-22

### Features

- **Terminal auth (`--setup`)**: interactively collect and save the Codebuff API
  key. The agent now advertises a `terminal` auth method (`args: ["--setup"]`)
  in its `initialize` response, so ACP clients (e.g. Zed) can offer a
  "Configure Codebuff" action. The key is stored at
  `~/.codebuff-acp/config.json`; `CODEBUFF_API_KEY` still takes precedence.
  Required for listing in the
  [ACP registry](https://github.com/agentclientprotocol/registry).

## [0.1.0] - 2026-07-21

Initial public release of `codebuff-agent-acp`, an unofficial
[ACP](https://agentclientprotocol.com) (Agent Client Protocol) adapter that
exposes the [Codebuff](https://github.com/CodebuffAI/codebuff) agent engine
(via [`@codebuff/sdk`](https://www.npmjs.com/package/@codebuff/sdk)) to any
ACP-compatible client such as [Zed](https://zed.dev).

### Features

- **ACP agent over `@codebuff/sdk`**: one `CodebuffClient` per session; each
  `session/prompt` runs a `client.run()`.
- **Full session lifecycle**: `initialize`, `authenticate`, `session/new`,
  `session/prompt`, `session/cancel`, `session/load`, `session/list`,
  `session/resume`, `session/fork`, `session/close`, `session/delete`,
  `session/set_mode`.
- **Streaming output**: assistant text via `agent_message_chunk` (token deltas
  with dedup against consolidated `text` events) and reasoning via
  `agent_thought_chunk`.
- **Tool calls**: rich titles, kinds, and file locations, with
  `tool_call_update` results.
- **Permission prompts**: edit/shell tools route through
  `session/request_permission` (allow / allow_always / reject / reject_always).
- **Sub-agents**: Codebuff's file-picker / planner / editor / reviewer surfaced
  as nested tool calls.
- **Plans**: the model's `write_todos` is mirrored as an ACP `plan` update.
- **Multimodal input**: image content blocks.
- **Persistent sessions**: resumable `RunState` stored under
  `~/.codebuff-acp/sessions/`, enabling reopen / resume / fork across restarts.

### Tooling & infrastructure

- Lint and format with [oxlint](https://oxc.rs) + [oxfmt](https://oxc.rs); tests
  with Vitest (72 tests).
- GitHub Actions: `CI` (lint, typecheck, format, test, build) and `Release`
  (publish to npm with provenance on a published GitHub Release).
- Local example (`examples/steering.ts`) and an opencode `release` skill.
