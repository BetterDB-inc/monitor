import { createHash } from "node:crypto";
import type {
  MessageCreateParamsNonStreaming,
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources";
import type { ContentBlock, LlmCacheParams, TextBlock, BinaryBlock, ToolCallBlock, ReasoningBlock, BlockHints } from "../types";
import type { BinaryNormalizer, BinaryRef } from "../normalizer";
import { defaultNormalizer } from "../normalizer";

export interface AnthropicPrepareOptions {
  normalizer?: BinaryNormalizer;
}

function buildCacheHints(cc: { type: string; ttl?: string } | null | undefined): BlockHints | undefined {
  if (!cc) return undefined;
  return {
    anthropicCacheControl: {
      type: "ephemeral" as const,
      ...(cc.ttl ? { ttl: cc.ttl as "5m" | "1h" } : {}),
    },
  };
}

async function normalizeBlock(
  block: ContentBlockParam,
  normalizer: BinaryNormalizer,
): Promise<ContentBlock | null> {
  const type = (block as { type: string }).type;

  if (type === "text") {
    const b = block as TextBlockParam;
    const result: TextBlock = { type: "text", text: b.text };
    const hints = buildCacheHints(b.cache_control);
    if (hints) result.hints = hints;
    return result;
  }

  if (type === "image") {
    const b = block as ImageBlockParam;
    const src = b.source as { type: string; data?: string; media_type?: string; url?: string; file_id?: string };
    let source: BinaryRef["source"];
    let mediaType = "image/*";

    if (src.type === "base64") {
      source = { type: "base64", data: src.data! };
      mediaType = src.media_type ?? "image/*";
    } else if (src.type === "url") {
      source = { type: "url", url: src.url! };
    } else if (src.type === "file") {
      source = { type: "fileId", fileId: src.file_id!, provider: "anthropic" };
    } else {
      return null;
    }

    const ref = await normalizer({ kind: "image", source });
    const result: BinaryBlock = { type: "binary", kind: "image", mediaType, ref };
    const hints = buildCacheHints((b as { cache_control?: { type: string; ttl?: string } | null }).cache_control);
    if (hints) result.hints = hints;
    return result;
  }

  if (type === "document") {
    const b = block as DocumentBlockParam;
    const src = b.source as { type: string; data?: string; text?: string; media_type?: string; url?: string; content?: unknown; file_id?: string };

    if (src.type === "content") {
      const fullJson = JSON.stringify(src.content);
      const ref = "nested:sha256:" + createHash("sha256").update(fullJson).digest("hex");
      const result: BinaryBlock = { type: "binary", kind: "document", mediaType: "application/x-nested-content", ref };
      return result;
    }

    let source: BinaryRef["source"];
    let mediaType = "application/octet-stream";

    if (src.type === "base64") {
      source = { type: "base64", data: src.data! };
      mediaType = src.media_type ?? "application/pdf";
    } else if (src.type === "text") {
      const encoded = Buffer.from(src.text!).toString("base64");
      source = { type: "base64", data: encoded };
      mediaType = "text/plain";
    } else if (src.type === "url") {
      source = { type: "url", url: src.url! };
      mediaType = "application/pdf";
    } else if (src.type === "file") {
      source = { type: "fileId", fileId: src.file_id!, provider: "anthropic" };
    } else {
      return null;
    }

    const ref = await normalizer({ kind: "document", source });
    const result: BinaryBlock = { type: "binary", kind: "document", mediaType, ref };
    const hints = buildCacheHints((b as { cache_control?: { type: string; ttl?: string } | null }).cache_control);
    if (hints) result.hints = hints;
    return result;
  }

  if (type === "tool_use") {
    const b = block as ToolUseBlockParam;
    return { type: "tool_call", id: b.id, name: b.name, args: b.input } as ToolCallBlock;
  }

  if (type === "thinking") {
    const b = block as { type: "thinking"; thinking: string; signature: string };
    return { type: "reasoning", text: b.thinking, opaqueSignature: b.signature } as ReasoningBlock;
  }

  if (type === "redacted_thinking") {
    const b = block as { type: "redacted_thinking"; data: string };
    return { type: "reasoning", text: "", redacted: true, opaqueSignature: b.data } as ReasoningBlock;
  }

  return null;
}

async function normalizeToolResultContent(
  content: string | Array<{ type: string; [k: string]: unknown }>,
  normalizer: BinaryNormalizer,
): Promise<(TextBlock | BinaryBlock)[]> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const blocks: (TextBlock | BinaryBlock)[] = [];
  for (const item of content) {
    if (item.type === "text") {
      blocks.push({ type: "text", text: item.text as string });
    } else if (item.type === "image") {
      const b = await normalizeBlock(item as unknown as ContentBlockParam, normalizer);
      if (b && b.type === "binary") blocks.push(b as BinaryBlock);
    }
  }
  return blocks;
}

export async function prepareParams(
  params: MessageCreateParamsNonStreaming,
  opts?: AnthropicPrepareOptions,
): Promise<LlmCacheParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;
  const messages: Array<{ role: string; content: unknown; toolCallId?: string; name?: string }> = [];

  // Prepend system message
  if (params.system) {
    if (typeof params.system === "string") {
      messages.push({ role: "system", content: params.system });
    } else {
      const blocks: TextBlock[] = (params.system as TextBlockParam[]).map(b => {
        const tb: TextBlock = { type: "text", text: b.text };
        const hints = buildCacheHints(b.cache_control);
        if (hints) tb.hints = hints;
        return tb;
      });
      messages.push({ role: "system", content: blocks });
    }
  }

  for (const msg of params.messages) {
    const content = msg.content;

    if (msg.role === "assistant") {
      if (typeof content === "string") {
        messages.push({ role: "assistant", content: [{ type: "text", text: content }] });
      } else {
        const blocks: ContentBlock[] = [];
        for (const blk of content as ContentBlockParam[]) {
          const b = await normalizeBlock(blk, normalizer);
          if (b) blocks.push(b);
        }
        messages.push({ role: "assistant", content: blocks });
      }
    } else {
      // role === "user" - check for tool_result blocks
      if (typeof content === "string") {
        messages.push({ role: "user", content: [{ type: "text", text: content }] });
        continue;
      }

      const parts = content as ContentBlockParam[];
      const toolResults = parts.filter(p => (p as { type: string }).type === "tool_result") as ToolResultBlockParam[];
      const others = parts.filter(p => (p as { type: string }).type !== "tool_result");

      // Each tool_result becomes a separate tool message
      for (const tr of toolResults) {
        const trContent = await normalizeToolResultContent(
          (tr as unknown as { content?: string | Array<{ type: string; [k: string]: unknown }>; tool_use_id: string }).content ?? "",
          normalizer,
        );
        messages.push({
          role: "tool",
          toolCallId: tr.tool_use_id,
          content: trContent,
        });
      }

      // Remaining blocks become a user message (only if there are any)
      if (others.length > 0) {
        const blocks: ContentBlock[] = [];
        for (const blk of others) {
          const b = await normalizeBlock(blk, normalizer);
          if (b) blocks.push(b);
        }
        messages.push({ role: "user", content: blocks });
      }
    }
  }

  const result: LlmCacheParams = { model: params.model, messages };
  if (params.temperature != null) result.temperature = params.temperature;
  if (params.top_p != null) result.top_p = params.top_p;
  if (params.max_tokens != null) result.max_tokens = params.max_tokens;
  if (params.tools != null) result.tools = params.tools as unknown as LlmCacheParams["tools"];
  if (params.tool_choice != null) result.toolChoice = params.tool_choice;
  if (params.stop_sequences != null) result.stop = params.stop_sequences;

  return result;
}
