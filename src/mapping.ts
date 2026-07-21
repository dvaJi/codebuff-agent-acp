/**
 * Pure helpers that translate Codebuff tool calls into ACP tool-call shapes.
 *
 * Codebuff reports tool calls as `{ toolName, input, toolCallId }`. ACP models
 * them as a `tool_call` / `tool_call_update` carrying `{ title, kind, status,
 * locations, rawInput, rawOutput }`. These helpers bridge the two without any
 * protocol I/O, so they're easy to unit-test.
 */

import type { ToolKind } from "@agentclientprotocol/sdk";

type ToolInput = Record<string, any>;

/** Tools that mutate the filesystem or shell and so warrant a permission prompt. */
const GATED_TOOLS = new Set([
  "run_terminal_command",
  "write_file",
  "propose_write_file",
  "str_replace",
  "propose_str_replace",
  "apply_patch",
  "run_file_change_hooks",
]);

export function isGatedTool(toolName: string): boolean {
  return GATED_TOOLS.has(toolName);
}

const READ_TOOLS = new Set([
  "read_files",
  "read_subtree",
  "list_directory",
  "lookup_agent_info",
]);
const SEARCH_TOOLS = new Set(["find_files", "glob", "code_search"]);
const FETCH_TOOLS = new Set(["web_search", "read_docs"]);
const EXEC_TOOLS = new Set(["run_terminal_command", "browser_logs", "skill"]);
const EDIT_TOOLS = new Set([
  "write_file",
  "propose_write_file",
  "str_replace",
  "propose_str_replace",
  "apply_patch",
  "run_file_change_hooks",
]);
const THINK_TOOLS = new Set([
  "think_deeply",
  "create_plan",
  "write_todos",
  "add_subgoal",
  "update_subgoal",
  "task_completed",
  "end_turn",
  "set_output",
  "suggest_followups",
  "add_message",
  "set_messages",
  "ask_user",
]);

export function toolKind(toolName: string): ToolKind {
  if (READ_TOOLS.has(toolName)) return "read";
  if (SEARCH_TOOLS.has(toolName)) return "search";
  if (FETCH_TOOLS.has(toolName)) return "fetch";
  if (EXEC_TOOLS.has(toolName)) return "execute";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (THINK_TOOLS.has(toolName)) return "think";
  return "other";
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Build a short, human-readable title for a tool call. */
export function toolTitle(toolName: string, input: ToolInput): string {
  switch (toolName) {
    case "run_terminal_command":
      return `$ ${input.command ?? ""}`.trim();
    case "write_file":
    case "propose_write_file":
      return `Write ${input.path ?? ""}`.trim();
    case "str_replace":
    case "propose_str_replace":
      return `Edit ${input.path ?? ""}`.trim();
    case "apply_patch": {
      const op = input.operation ?? {};
      const verb =
        op.type === "delete_file"
          ? "Delete"
          : op.type === "create_file"
            ? "Create"
            : "Edit";
      return `${verb} ${op.path ?? ""}`.trim();
    }
    case "read_files":
      return `Read ${pathsLabel(input.paths)}`;
    case "read_subtree":
      return `Read subtree ${pathsLabel(input.paths)}`;
    case "list_directory":
      return `List ${input.path ?? ""}`.trim();
    case "find_files":
      return `Find files: ${input.prompt ?? ""}`.trim();
    case "glob":
      return `Glob ${input.pattern ?? ""}`.trim();
    case "code_search":
      return `Search "${input.pattern ?? ""}"`.trim();
    case "web_search":
      return `Web search "${input.query ?? ""}"`.trim();
    case "read_docs":
      return `Docs: ${input.libraryTitle ?? ""}`.trim();
    case "run_file_change_hooks":
      return `Change hooks ${pathsLabel(input.files)}`;
    case "spawn_agents":
    case "spawn_agent_inline": {
      const agents =
        (input.agents as Array<{ agent_type?: string }> | undefined) ?? [];
      return `Spawn ${
        agents
          .map((a) => a.agent_type)
          .filter(Boolean)
          .join(", ") || "agent"
      }`;
    }
    case "ask_user":
      return "Ask user";
    case "write_todos":
      return "Update plan";
    default:
      return toolName;
  }
}

function pathsLabel(paths: unknown): string {
  if (!Array.isArray(paths)) return "";
  const list = paths.filter((p): p is string => typeof p === "string");
  if (list.length === 0) return "";
  return list.length <= 2
    ? list.join(", ")
    : `${list[0]} +${list.length - 1} more`;
}

/** Filesystem locations a tool call touches, for client "follow-along" UIs. */
export function toolLocations(
  toolName: string,
  input: ToolInput,
): Array<{ path: string }> {
  const out: Array<{ path: string }> = [];
  const push = (p: unknown) => {
    if (typeof p === "string" && p.length > 0) out.push({ path: p });
  };
  switch (toolName) {
    case "write_file":
    case "propose_write_file":
    case "str_replace":
    case "propose_str_replace":
      push(input.path);
      break;
    case "apply_patch":
      push(input.operation?.path);
      break;
    case "read_files":
    case "read_subtree":
    case "run_file_change_hooks":
      (Array.isArray(input.paths)
        ? input.paths
        : Array.isArray(input.files)
          ? input.files
          : []
      ).forEach(push);
      break;
    case "list_directory":
      push(input.path);
      break;
    case "code_search":
    case "glob":
      push(input.cwd);
      break;
    default:
      break;
  }
  return out;
}

/** A reasonable guess at the "primary" argument, used as a permission scope hint. */
export function toolScopeDescription(
  toolName: string,
  input: ToolInput,
): string {
  const loc = toolLocations(toolName, input)
    .map((l) => l.path)
    .join(", ");
  if (loc) return loc;
  return (
    firstString(input.command, input.pattern, input.query, input.prompt) ??
    toolName
  );
}
