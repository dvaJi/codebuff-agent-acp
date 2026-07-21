/**
 * Pure conversions between ACP content and Codebuff's message model.
 *
 * Kept side-effect-free and isolated from the agent so they're trivial to test.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { MessageContent, RunState } from "@codebuff/sdk";

/** Codebuff's run output discriminated union (derived from `RunState`). */
export type AgentOutput = RunState["output"];

/**
 * Convert an ACP user prompt (a list of content blocks) into Codebuff's
 * `{ prompt, content }`. Text / resource references become the prompt string;
 * images become Codebuff multimodal `content`.
 */
export function promptToCodebuff(blocks: Array<ContentBlock>): {
  prompt: string;
  content: MessageContent[];
} {
  const textParts: string[] = [];
  const content: MessageContent[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) textParts.push(block.text);
        break;
      case "image":
        if (block.data) {
          content.push({
            type: "image",
            image: block.data,
            mediaType: block.mimeType ?? "image/png",
          });
        }
        break;
      case "resource_link": {
        const uri = (block as { uri?: string }).uri;
        const name = (block as { name?: string }).name;
        const ref = uri ?? name;
        if (ref) {
          const p = ref.startsWith("file://")
            ? decodeURIComponent(ref.slice("file://".length))
            : ref;
          textParts.push(`@${p}`);
        }
        break;
      }
      case "resource": {
        const text = (block as { resource?: { text?: string } }).resource?.text;
        if (typeof text === "string") textParts.push(text);
        break;
      }
      default:
        break;
    }
  }

  const prompt = textParts.join("\n\n").trim() || " ";
  return { prompt, content };
}

/** Extract readable text from a Codebuff run output. */
export function textFromOutput(output: AgentOutput): string | undefined {
  switch (output.type) {
    case "error":
      return `⚠️ ${output.message}`;
    case "structuredOutput":
      try {
        return `\`\`\`json\n${JSON.stringify(output.value, null, 2)}\n\`\`\``;
      } catch {
        return undefined;
      }
    case "lastMessage":
      return partsToText(output.value as unknown);
    case "allMessages": {
      const messages =
        (output.value as Array<{ role?: string; content?: unknown }>) ?? [];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      return lastAssistant ? partsToText(lastAssistant.content) : undefined;
    }
    default:
      return undefined;
  }
}

/** Flatten Codebuff message content parts into a single text string. */
export function partsToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const part of value) {
    const text = (part as { text?: string })?.text;
    if (typeof text === "string") out.push(text);
  }
  const joined = out.join("");
  return joined.length > 0 ? joined : undefined;
}
