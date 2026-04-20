import type {
  ChatCompletionCreateParams,
  ChatCompletionContentPart,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { ContentBlock, LlmCacheParams, TextBlock, BinaryBlock, ToolCallBlock } from "../types";
import type { BinaryNormalizer, BinaryRef } from "../normalizer";
import { defaultNormalizer } from "../normalizer";
import { parseToolCallArgs } from "../utils";

export interface OpenAIChatPrepareOptions {
  normalizer?: BinaryNormalizer;
}

function toolCallFromAny(tc: ChatCompletionMessageToolCall): ToolCallBlock | null {
  if (tc.type !== "function") return null;
  return {
    type: "tool_call",
    id: tc.id,
    name: tc.function.name,
    args: parseToolCallArgs(tc.function.arguments),
  };
}

async function normalizeUserContent(
  content: string | ChatCompletionContentPart[],
  normalizer: BinaryNormalizer,
): Promise<ContentBlock[]> {
  if (typeof content === "string") return [{ type: "text", text: content } as TextBlock];

  const blocks: ContentBlock[] = [];

  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text } as TextBlock);
    } else if (part.type === "image_url") {
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
      const block: BinaryBlock = { type: "binary", kind: "image", mediaType, ref };
      if (part.image_url.detail) block.detail = part.image_url.detail;
      blocks.push(block);
    } else if (part.type === "input_audio") {
      const ref = await normalizer({
        kind: "audio",
        source: { type: "base64", data: part.input_audio.data },
      });
      blocks.push({
        type: "binary",
        kind: "audio",
        mediaType: `audio/${part.input_audio.format}`,
        ref,
      } as BinaryBlock);
    } else if (part.type === "file") {
      const { file_id, file_data, filename } = part.file;
      let source: BinaryRef["source"];
      let mediaType = "application/octet-stream";
      if (file_id) {
        source = { type: "fileId", fileId: file_id, provider: "openai" };
      } else if (file_data) {
        if (file_data.startsWith("data:")) {
          const semi = file_data.indexOf(";");
          if (semi > 5) mediaType = file_data.slice(5, semi);
        }
        source = { type: "base64", data: file_data };
      } else {
        continue;
      }
      const ref = await normalizer({ kind: "document", source });
      const block: BinaryBlock = { type: "binary", kind: "document", mediaType, ref };
      if (filename) block.filename = filename;
      blocks.push(block);
    }
  }

  return blocks;
}

export async function prepareParams(
  params: ChatCompletionCreateParams,
  opts?: OpenAIChatPrepareOptions,
): Promise<LlmCacheParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;
  const messages: Array<{ role: string; content: unknown; toolCallId?: string; name?: string }> = [];

  for (const msg of params.messages) {
    const role = msg.role as string;

    if (role === "system" || role === "developer") {
      const m = msg as { content: string | Array<{ type: string; text?: string }> };
      if (typeof m.content === "string") {
        messages.push({ role: "system", content: m.content });
      } else {
        const blocks: TextBlock[] = m.content
          .filter(p => p.type === "text" && p.text !== undefined)
          .map(p => ({ type: "text" as const, text: p.text! }));
        messages.push({ role: "system", content: blocks });
      }
    } else if (role === "user") {
      const m = msg as { content: string | ChatCompletionContentPart[]; name?: string };
      const content = await normalizeUserContent(m.content, normalizer);
      const entry: { role: string; content: unknown; name?: string } = { role: "user", content };
      if (m.name) entry.name = m.name;
      messages.push(entry);
    } else if (role === "assistant") {
      const m = msg as {
        content?: string | Array<{ type: string; text?: string }> | null;
        tool_calls?: ChatCompletionMessageToolCall[];
      };
      const blocks: ContentBlock[] = [];
      if (m.content) {
        if (typeof m.content === "string") {
          blocks.push({ type: "text", text: m.content } as TextBlock);
        } else {
          for (const part of m.content) {
            if (part.type === "text" && part.text !== undefined) {
              blocks.push({ type: "text", text: part.text } as TextBlock);
            }
          }
        }
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          const block = toolCallFromAny(tc);
          if (block) blocks.push(block);
        }
      }
      messages.push({ role: "assistant", content: blocks });
    } else if (role === "tool") {
      const m = msg as { tool_call_id: string; content: string | Array<{ type: string; text?: string }> };
      const text = typeof m.content === "string"
        ? m.content
        : m.content.filter(p => p.type === "text").map(p => p.text ?? "").join("");
      messages.push({
        role: "tool",
        toolCallId: m.tool_call_id,
        content: [{ type: "text", text } as TextBlock],
      });
    } else if (role === "function") {
      const m = msg as { name: string; content: string | null };
      messages.push({
        role: "tool",
        toolCallId: `legacy:${m.name}`,
        content: [{ type: "text", text: m.content ?? "" } as TextBlock],
      });
    }
  }

  const result: LlmCacheParams = { model: params.model, messages };
  if (params.temperature != null) result.temperature = params.temperature;
  if (params.top_p != null) result.top_p = params.top_p;
  if (params.max_tokens != null) result.max_tokens = params.max_tokens;
  if (params.tools != null) result.tools = params.tools as LlmCacheParams["tools"];
  if (params.tool_choice != null) result.toolChoice = params.tool_choice;
  if (params.seed != null) result.seed = params.seed;
  if (params.stop != null) {
    result.stop = typeof params.stop === "string" ? [params.stop] : (params.stop as string[]);
  }
  if (params.response_format != null) result.responseFormat = params.response_format;
  const promptCacheKey = (params as unknown as Record<string, unknown>).prompt_cache_key;
  if (promptCacheKey != null) result.promptCacheKey = promptCacheKey as string;

  return result;
}
