import type { ChatMessage } from "@llamaindex/core/llms";
import type { ContentBlock, LlmCacheParams, TextBlock, BinaryBlock, ToolCallBlock } from "../types";
import type { BinaryNormalizer, BinaryRef } from "../normalizer";
import { defaultNormalizer } from "../normalizer";

export interface LlamaIndexPrepareOptions {
  model: string;
  normalizer?: BinaryNormalizer;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

type AnyDetail = { type: string; text?: string; image_url?: { url: string }; data?: string; mimeType?: string };

function parseInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return { __raw: input };
    }
  }
  return input;
}

async function normalizeDetail(
  part: AnyDetail,
  normalizer: BinaryNormalizer,
): Promise<ContentBlock | null> {
  if (part.type === "text") {
    return { type: "text", text: part.text ?? "" } as TextBlock;
  }

  if (part.type === "image_url" && part.image_url) {
    const url = part.image_url.url;
    let source: BinaryRef["source"];
    let mediaType = "image/*";
    if (url.startsWith("data:")) {
      const semi = url.indexOf(";");
      if (semi > 5) mediaType = url.slice(5, semi);
      source = { type: "base64", data: url };
    } else {
      source = { type: "url", url };
    }
    const ref = await normalizer({ kind: "image", source });
    return { type: "binary", kind: "image", mediaType, ref } as BinaryBlock;
  }

  if (part.type === "file" && part.data) {
    const ref = await normalizer({ kind: "document", source: { type: "base64", data: part.data } });
    return { type: "binary", kind: "document", mediaType: part.mimeType ?? "application/octet-stream", ref } as BinaryBlock;
  }

  if ((part.type === "audio" || part.type === "image") && part.data) {
    const kind = part.type === "audio" ? "audio" as const : "image" as const;
    const ref = await normalizer({ kind, source: { type: "base64", data: part.data } });
    return { type: "binary", kind, mediaType: part.mimeType ?? (kind === "audio" ? "audio/*" : "image/*"), ref } as BinaryBlock;
  }

  return null;
}

export async function prepareParams(
  messages: ChatMessage[],
  opts: LlamaIndexPrepareOptions,
): Promise<LlmCacheParams> {
  const normalizer = opts.normalizer ?? defaultNormalizer;
  const out: Array<{ role: string; content: unknown; toolCallId?: string }> = [];

  for (const msg of messages) {
    const options = (msg as { options?: { toolCall?: unknown[]; toolResult?: { id: string; result: string; isError?: boolean } } }).options;

    // Tool result takes highest priority
    if (options?.toolResult) {
      const tr = options.toolResult;
      out.push({
        role: "tool",
        toolCallId: tr.id,
        content: [{ type: "text", text: tr.result } as TextBlock],
      });
      continue;
    }

    // Map role
    const rawRole = msg.role as string;
    const role = rawRole === "memory" || rawRole === "developer" ? "system" : rawRole;

    // Normalize content
    const blocks: ContentBlock[] = [];
    if (typeof msg.content === "string") {
      if (msg.content !== "") {
        blocks.push({ type: "text", text: msg.content } as TextBlock);
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as AnyDetail[]) {
        const b = await normalizeDetail(part, normalizer);
        if (b) blocks.push(b);
      }
    }

    // Append tool calls from options
    if (options?.toolCall) {
      const calls = Array.isArray(options.toolCall) ? options.toolCall : [options.toolCall];
      for (const tc of calls as Array<{ id: string; name: string; input: unknown }>) {
        blocks.push({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          args: parseInput(tc.input),
        } as ToolCallBlock);
      }
    }

    out.push({ role, content: blocks });
  }

  const result: LlmCacheParams = { model: opts.model, messages: out };
  if (opts.temperature != null) result.temperature = opts.temperature;
  if (opts.topP != null) result.top_p = opts.topP;
  if (opts.maxTokens != null) result.max_tokens = opts.maxTokens;

  return result;
}
