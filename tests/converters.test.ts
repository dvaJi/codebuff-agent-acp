import { describe, expect, it } from "vitest";

import {
  partsToText,
  promptToCodebuff,
  textFromOutput,
} from "../src/converters.js";
import type { AgentOutput } from "../src/converters.js";

describe("promptToCodebuff", () => {
  it("turns a text block into a prompt string", () => {
    const { prompt, content } = promptToCodebuff([
      { type: "text", text: "hello" },
    ]);
    expect(prompt).toBe("hello");
    expect(content).toEqual([]); // text goes to prompt, not content
  });

  it("joins multiple text blocks with blank lines", () => {
    const { prompt } = promptToCodebuff([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(prompt).toBe("first\n\nsecond");
  });

  it("keeps a default prompt when only an image is provided", () => {
    const { prompt, content } = promptToCodebuff([
      { type: "image", data: "QUFB", mimeType: "image/png" },
    ]);
    expect(prompt).toBe(" ");
    expect(content).toEqual([
      { type: "image", image: "QUFB", mediaType: "image/png" },
    ]);
  });

  it("mixes text and images", () => {
    const { prompt, content } = promptToCodebuff([
      { type: "text", text: "what is this?" },
      { type: "image", data: "QUFB", mimeType: "image/png" },
    ]);
    expect(prompt).toBe("what is this?");
    expect(content).toHaveLength(1);
  });

  it("converts a file:// resource_link into an @-mention", () => {
    const { prompt } = promptToCodebuff([
      {
        type: "resource_link",
        uri: "file:///abs/path/src/index.ts",
        name: "index.ts",
      } as never,
    ]);
    expect(prompt).toBe("@/abs/path/src/index.ts");
  });

  it("falls back to the name for a non-file resource_link", () => {
    const { prompt } = promptToCodebuff([
      { type: "resource_link", name: "README" } as never,
    ]);
    expect(prompt).toBe("@README");
  });

  it("inlines the text of an embedded resource", () => {
    const { prompt } = promptToCodebuff([
      {
        type: "resource",
        resource: { text: "embedded prose" },
      } as never,
    ]);
    expect(prompt).toBe("embedded prose");
  });
});

describe("textFromOutput", () => {
  it("reads the last assistant message from allMessages", () => {
    const output = {
      type: "allMessages",
      value: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "text", text: "the answer" }] },
      ],
    } as AgentOutput;
    expect(textFromOutput(output)).toBe("the answer");
  });

  it("joins parts of a lastMessage", () => {
    const output = {
      type: "lastMessage",
      value: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    } as AgentOutput;
    expect(textFromOutput(output)).toBe("hello world");
  });

  it("renders structured output as a json block", () => {
    const output = {
      type: "structuredOutput",
      value: { ok: true },
    } as AgentOutput;
    expect(textFromOutput(output)).toBe('```json\n{\n  "ok": true\n}\n```');
  });

  it("prefixes errors", () => {
    const output = {
      type: "error",
      message: "boom",
    } as AgentOutput;
    expect(textFromOutput(output)).toBe("⚠️ boom");
  });

  it("returns undefined when there is nothing to show", () => {
    const output = {
      type: "lastMessage",
      value: [{ type: "text", text: "" }],
    } as AgentOutput;
    expect(textFromOutput(output)).toBeUndefined();
  });
});

describe("partsToText", () => {
  it("passes strings through", () => {
    expect(partsToText("raw")).toBe("raw");
  });

  it("returns undefined for non-array non-string", () => {
    expect(partsToText(42)).toBeUndefined();
    expect(partsToText(undefined)).toBeUndefined();
  });
});
