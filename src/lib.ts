// Library entry point: re-exports the agent for programmatic use.
export {
  CodebuffAcpAgent,
  registerAcpHandlers,
  runAcp,
  type CodebuffAcpAgentOptions,
  type CodebuffClientLike,
} from "./agent.js";
export {
  promptToCodebuff,
  textFromOutput,
  partsToText,
  type AgentOutput,
} from "./converters.js";
export {
  saveSession,
  loadSessionRecord,
  listSessionRecords,
  deleteSession,
  titleFromPrompt,
  type SessionRecord,
} from "./sessions.js";
export {
  isGatedTool,
  toolKind,
  toolTitle,
  toolLocations,
  toolScopeDescription,
} from "./mapping.js";
