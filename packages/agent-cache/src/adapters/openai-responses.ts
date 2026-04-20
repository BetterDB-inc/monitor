import type { ResponseCreateParams } from "openai/resources/responses/responses";
import type { ContentBlock, LlmCacheParams, TextBlock, BinaryBlock, ToolCallBlock, ReasoningBlock } from "../types";
import type { BinaryNormalizer, BinaryRef } from "../normalizer";
import { defaultNormalizer } from "../normalizer";

export interface OpenAIResponsesPrepareOptions {
  normalizer?: BinaryNormalizer;
}

type AnyItem = { type?: string; role?: string; [k: string]: unknown };

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { __raw: raw };
  }
}

async function normalizeResponsesPart(
  part: AnyItem,
  normalizer: BinaryNormalizer,
): Promise<ContentBlock | null> {
  const t = part.type as string | undefined;

  if (t === "input_text" || t === "output_text") {
    return { type: "text", text: part.text as string ?? "" } as TextBlock;
  }

  if (t === "input_image") {
    const fileId = part.file_id as string | null | undefined;
    const imageUrl = part.image_url as string | null | undefined;
    const detail = part.detail as BinaryBlock["detail"] | undefined;

    let source: BinaryRef["source"];
    let mediaType = "image/*";

    if (fileId) {
      source = { type: "fileId", fileId, provider: "openai" };
    } else if (imageUrl) {
      if (imageUrl.startsWith("data:")) {
        const semi = imageUrl.indexOf(";");
        if (semi > 5) mediaType = imageUrl.slice(5, semi);
        source = { type: "base64", data: imageUrl };
      } else {
        source = { type: "url", url: imageUrl };
      }
    } else {
      return null;
    }

    const ref = await normalizer({ kind: "image", source });
    const block: BinaryBlock = { type: "binary", kind: "image", mediaType, ref };
    if (detail) block.detail = detail;
    return block;
  }

  if (t === "input_file") {
    const fileId = part.file_id as string | null | undefined;
    const fileData = part.file_data as string | null | undefined;
    const fileUrl = part.file_url as string | null | undefined;
    const filename = part.filename as string | null | undefined;

    let source: BinaryRef["source"];
    let mediaType = "application/octet-stream";

    if (fileId) {
      source = { type: "fileId", fileId, provider: "openai" };
    } else if (fileData) {
      if (fileData.startsWith("data:")) {
        const semi = fileData.indexOf(";");
        if (semi > 5) mediaType = fileData.slice(5, semi);
      }
      source = { type: "base64", data: fileData };
    } else if (fileUrl) {
      source = { type: "url", url: fileUrl };
    } else {
      return null;
    }

    const ref = await normalizer({ kind: "document", source });
    const block: BinaryBlock = { type: "binary", kind: "document", mediaType, ref };
    if (filename) block.filename = filename;
    return block;
  }

  return null;
}

async function normalizeMessageContent(
  content: string | unknown[],
  normalizer: BinaryNormalizer,
): Promise<string | ContentBlock[]> {
  if (typeof content === "string") return content;
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    const b = await normalizeResponsesPart(part as AnyItem, normalizer);
    if (b) blocks.push(b);
  }
  return blocks;
}

export async function prepareParams(
  params: ResponseCreateParams,
  opts?: OpenAIResponsesPrepareOptions,
): Promise<LlmCacheParams> {
  const normalizer = opts?.normalizer ?? defaultNormalizer;
  const messages: Array<{ role: string; content: unknown; toolCallId?: string }> = [];

  // Prepend instructions as system message
  const p = params as { instructions?: string | null; input?: string | unknown[]; model: string; temperature?: number | null; top_p?: number | null; max_output_tokens?: number | null; tools?: unknown; tool_choice?: unknown; reasoning?: { effort?: string } | null; prompt_cache_key?: string };

  if (p.instructions) {
    messages.push({ role: "system", content: p.instructions });
  }

  if (typeof p.input === "string") {
    messages.push({ role: "user", content: p.input });
  } else if (Array.isArray(p.input)) {
    let currentAssistant: { role: string; content: ContentBlock[] } | null = null;

    const flushAssistant = () => {
      if (currentAssistant && currentAssistant.content.length > 0) {
        messages.push({ ...currentAssistant });
      }
      currentAssistant = null;
    };

    for (const rawItem of p.input) {
      const item = rawItem as AnyItem;
      const itemType = item.type as string | undefined;

      if (itemType === "function_call") {
        if (!currentAssistant) currentAssistant = { role: "assistant", content: [] };
        currentAssistant.content.push({
          type: "tool_call",
          id: item.call_id as string,
          name: item.name as string,
          args: parseArgs(item.arguments as string),
        } as ToolCallBlock);
        continue;
      }

      if (itemType === "reasoning") {
        if (!currentAssistant) currentAssistant = { role: "assistant", content: [] };
        const summary = (item.summary as Array<{ type?: string; text: string }> | undefined) ?? [];
        const text = summary.filter(s => s.type === "reasoning_text").map(s => s.text).join("");
        currentAssistant.content.push({
          type: "reasoning",
          text,
          opaqueSignature: item.encrypted_content as string | undefined,
        } as ReasoningBlock);
        continue;
      }

      if (itemType === "function_call_output") {
        flushAssistant();
        const output = item.output;
        const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
        messages.push({
          role: "tool",
          toolCallId: item.call_id as string,
          content: [{ type: "text", text } as TextBlock],
        });
        continue;
      }

      // Message items (type === "message" or has role)
      flushAssistant();

      const role = (item.role ?? "user") as string;
      const content = item.content;

      if (content == null) continue;

      const normalizedContent = await normalizeMessageContent(
        content as string | unknown[],
        normalizer,
      );
      messages.push({ role, content: normalizedContent });
    }

    flushAssistant();
  }

  const result: LlmCacheParams = { model: p.model, messages };
  if (p.temperature != null) result.temperature = p.temperature;
  if (p.top_p != null) result.top_p = p.top_p;
  if (p.max_output_tokens != null) result.max_tokens = p.max_output_tokens;
  if (p.tools != null) result.tools = p.tools as LlmCacheParams["tools"];
  if (p.tool_choice != null) result.toolChoice = p.tool_choice;
  if (p.reasoning?.effort != null) result.reasoningEffort = p.reasoning.effort;
  if (p.prompt_cache_key != null) result.promptCacheKey = p.prompt_cache_key;

  return result;
}
