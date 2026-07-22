# codebuff-agent-acp

> **Unofficial / community project.** This project is **not** affiliated with,
> endorsed by, or sponsored by [Codebuff, Inc.](https://github.com/CodebuffAI)
> or the [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff) project.
> "Codebuff" is a trademark of its respective owners; all trademarks are the
> property of their respective holders. This is an independent, third-party
> adapter that consumes the publicly available
> [`@codebuff/sdk`](https://www.npmjs.com/package/@codebuff/sdk) package.

Use the [Codebuff](https://github.com/CodebuffAI/codebuff) agent engine from any
[ACP](https://agentclientprotocol.com)-compatible client (such as
[Zed](https://zed.dev)).

This package implements an **ACP agent** on top of the official
[`@codebuff/sdk`](https://www.npmjs.com/package/@codebuff/sdk), in the same vein
as [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
wraps the Claude Agent SDK.

## What works

- Streaming assistant output (`agent_message_chunk`) and reasoning
  (`agent_thought_chunk`)
- Tool calls with rich titles, kinds, and file locations, including
  `tool_call_update` results
- **Permission prompts** for mutating/shell tools via `session/request_permission`
- Sub-agents surfaced as nested tool calls (`spawn_agents` / Codebuff's
  file-picker, planner, editor, reviewer, …)
- The model's `write_todos` plan mirrored as an ACP `plan` update
- Image inputs
- **Persistent sessions**: `session/load`, `session/list`, `session/resume`,
  `session/fork`, `session/close`, `session/delete` — resumable `RunState` is
  stored under `~/.codebuff-acp/sessions/`
- `session/cancel` (aborts the in-flight Codebuff run)

## Install

```bash
npm install -g codebuff-agent-acp
# or run directly without installing:
npx codebuff-agent-acp
```

Set your Codebuff API key (get one from <https://codebuff.com>):

```bash
export CODEBUFF_API_KEY=cb_...
```

## Use with Zed

Add this to your Zed `settings.json`:

```jsonc
"agent_servers": {
  "Codebuff": {
    "command": "codebuff-agent-acp",
    "args": []
  }
}
```

Then open the Agent Panel and start a new **Codebuff** thread. (Run
`acp: open acp logs` from the command palette to inspect the wire traffic.)

## Run from source

```bash
npm install
npm run build       # outputs to dist/
./dist/index.js     # or: npm start
npm run dev         # run via tsx without building
```

You can sanity-check the stdio server by piping a raw JSON-RPC initialize:

```bash
echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | npm start
```

## Development

Tooling uses [oxlint](https://oxc.rs) for linting and [oxfmt](https://oxc.rs)
(Prettier-compatible) for formatting. Both are pre-configured (`.oxlintrc.json`,
`.oxfmtrc.json`).

```bash
npm run lint          # oxlint src tests
npm run lint:fix      # apply safe autofixes
npm run format        # oxfmt src tests (write)
npm run format:check  # oxfmt --check (CI uses this)
npm run typecheck     # tsc --noEmit over src + tests
npm run test          # vitest run (70 tests)
npm run check         # typecheck + lint + format:check + test
```

CI (`.github/workflows/ci.yml`) runs `npm run check && npm run build` on every
push and pull request.

## Releasing

Releases are published to npm by the `Release` workflow
(`.github/workflows/release.yml`) when a GitHub Release is published. It
mirrors the [canonical guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)
and publishes with [provenance](https://docs.npmjs.com/generating-provenance-statements).

1. Set the `NPM_TOKEN` repository secret (an automation/automation-class token,
   2FA-exempt) and create a `release` environment (optional but recommended).
2. Bump `version` in [`package.json`](./package.json) and commit.
3. Create a GitHub Release on the matching tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --generate-notes
   ```

The workflow verifies the release tag matches `package.json`, runs `npm run
check`, builds, and runs `npm publish --provenance --access public`
(requires the workflow's `id-token: write` permission, which is already set).

## Configuration

The Codebuff API key is resolved in this order:

1. `CODEBUFF_API_KEY` environment variable.
2. The key saved by `--setup` (below), stored at
   `~/.codebuff-acp/config.json`.

### Interactive setup (Terminal Auth)

```bash
npx codebuff-agent-acp --setup
```

Prompts for your Codebuff API key (get one from
<https://codebuff.com> → Profile → API Keys) and saves it locally. ACP clients
that drive the agent can also trigger this via the `terminal` auth method
advertised in `initialize` (`args: ["--setup"]`).

### Environment variables

| Env var             | Default           | Description                                         |
| ------------------- | ----------------- | --------------------------------------------------- |
| `CODEBUFF_API_KEY`  | _none_            | Codebuff API key (overrides the saved key)          |
| `CODEBUFF_AGENT`    | `base`            | Codebuff agent id to run (e.g. `base`, `base_free`) |
| `CODEBUFF_ACP_HOME` | `~/.codebuff-acp` | Where config + session files are stored             |

A client may also pass an API key at runtime via the `authenticate` request's
`_meta.codebuff.apiKey` (it's persisted for future sessions).

## Limitations

- **Permission prompts are advisory, not hard-gating.** Codebuff executes its
  built-in tools itself and only reports them via events, so a rejected
  permission marks the tool call as failed in the UI but cannot always un-execute
  it. (True pre-execution gating would require re-implementing Codebuff's
  `write_file` / `str_replace` / `apply_patch` / `run_terminal_command` via the
  SDK's `overrideTools` — a follow-up.)
- Client-provided **MCP servers are not wired** into Codebuff (the SDK exposes
  MCP config on agent definitions, not the client). `mcp_capabilities` is
  advertised as unsupported.
- Session history replay on `session/load` is text-only (tool history is not
  reconstructed).

## License

Apache-2.0
