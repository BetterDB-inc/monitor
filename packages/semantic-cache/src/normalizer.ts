import { createHash } from "node:crypto";

// --- Types ---

export interface BinaryRef {
  kind: "image" | "audio" | "document";
  source:
    | { type: "base64"; data: string; mediaType?: string }
    | { type: "url"; url: string }
    | { type: "fileId"; fileId: string; provider: string }
    | { type: "bytes"; data: Uint8Array | Buffer };
  context?: Record<string, unknown>;
}

export type BinaryNormalizer = (ref: BinaryRef) => Promise<string>;

export interface NormalizerConfig {
  base64?: (data: string) => string | Promise<string>;
  url?: (urlStr: string) => string | Promise<string>;
  fileId?: (fileId: string, provider: string) => string | Promise<string>;
  bytes?: (data: Uint8Array | Buffer) => string | Promise<string>;
  byKind?: {
    image?: BinaryNormalizer;
    audio?: BinaryNormalizer;
    document?: BinaryNormalizer;
  };
}

// --- Normalizer functions ---

/**
 * Strip any "data:<mime>;base64," prefix, decode the base64 bytes,
 * and return "sha256:<hex>" of the decoded bytes.
 */
export function hashBase64(data: string): string {
  const raw = data.includes(";base64,") ? data.split(";base64,")[1] : data;
  const bytes = Buffer.from(raw, "base64");
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * Return "sha256:<hex>" of the raw bytes.
 */
export function hashBytes(data: Uint8Array | Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/**
 * Normalize a URL: lowercase scheme+host, drop default ports (80/443),
 * sort query params, return "url:<normalized>".
 */
export function hashUrl(urlStr: string): string {
  const url = new URL(urlStr);
  // URL constructor lowercases scheme and hostname; also drops default ports
  url.searchParams.sort();
  return "url:" + url.toString();
}

/**
 * Fetch a URL, throw if response is not ok, and return "sha256:<hex>"
 * of the response body bytes.
 */
export async function fetchAndHash(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchAndHash: HTTP ${res.status} for ${url}`);
  }
  const buf = await res.arrayBuffer();
  return "sha256:" + createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

/**
 * Return a scheme-prefixed reference without any normalization:
 * - base64 source  -> "base64:<data>"
 * - url source     -> "url:<url>"
 * - fileId source  -> "fileid:<provider>:<fileId>"
 * - bytes source   -> "sha256:<hex>" (hashes the bytes)
 */
export function passthrough(ref: BinaryRef): string {
  const { source } = ref;
  switch (source.type) {
    case "base64":
      return "base64:" + source.data;
    case "url":
      return "url:" + source.url;
    case "fileId":
      return "fileid:" + source.provider + ":" + source.fileId;
    case "bytes":
      return hashBytes(source.data);
  }
}

// --- Factory ---

/**
 * Build a BinaryNormalizer from a config.
 *
 * Dispatch order:
 * 1. If cfg.byKind[ref.kind] is defined, call it with the full BinaryRef.
 * 2. Otherwise dispatch on ref.source.type using the per-source handlers.
 * 3. Fall back to passthrough for any unhandled source types.
 */
export function composeNormalizer(cfg: NormalizerConfig = {}): BinaryNormalizer {
  return async (ref: BinaryRef): Promise<string> => {
    // byKind takes priority
    const kindFn = cfg.byKind?.[ref.kind];
    if (kindFn) return kindFn(ref);

    const { source } = ref;
    switch (source.type) {
      case "base64":
        return cfg.base64 ? cfg.base64(source.data) : passthrough(ref);
      case "url":
        return cfg.url ? cfg.url(source.url) : passthrough(ref);
      case "fileId":
        return cfg.fileId
          ? cfg.fileId(source.fileId, source.provider)
          : passthrough(ref);
      case "bytes":
        return cfg.bytes ? cfg.bytes(source.data) : passthrough(ref);
    }
  };
}

export const defaultNormalizer: BinaryNormalizer = composeNormalizer({
  base64: hashBase64,
  bytes: hashBytes,
});
