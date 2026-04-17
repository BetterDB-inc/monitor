import { describe, it, expect, vi } from "vitest";
import {
  hashBase64,
  hashBytes,
  hashUrl,
  fetchAndHash,
  passthrough,
  composeNormalizer,
} from "../normalizer";
import type { BinaryRef } from "../normalizer";

// Known sha256 values
const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const SHA256_HELLO_WORLD = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

describe("hashBase64", () => {
  it("strips data URL prefix and data URL without prefix produce same hash", () => {
    const withPrefix = hashBase64("data:image/png;base64,aGVsbG8=");
    const withoutPrefix = hashBase64("aGVsbG8=");
    expect(withPrefix).toBe(withoutPrefix);
  });

  it("produces sha256 of decoded bytes for hello", () => {
    // aGVsbG8= is base64 for "hello"
    expect(hashBase64("aGVsbG8=")).toBe("sha256:" + SHA256_HELLO);
  });

  it("different bytes produce different hashes", () => {
    const h1 = hashBase64("aGVsbG8="); // "hello"
    const h2 = hashBase64("d29ybGQ="); // "world"
    expect(h1).not.toBe(h2);
  });
});

describe("hashBytes", () => {
  it("returns sha256: prefixed hex of bytes", () => {
    const bytes = Buffer.from("hello");
    expect(hashBytes(bytes)).toBe("sha256:" + SHA256_HELLO);
  });

  it("accepts Uint8Array", () => {
    const arr = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(hashBytes(arr)).toBe("sha256:" + SHA256_HELLO);
  });
});

describe("hashUrl", () => {
  it("normalizes case and default https port", () => {
    const a = hashUrl("HTTPS://Example.COM:443/foo?b=2&a=1");
    const b = hashUrl("https://example.com/foo?a=1&b=2");
    expect(a).toBe(b);
  });

  it("normalizes default http port", () => {
    const a = hashUrl("http://example.com:80/path");
    const b = hashUrl("http://example.com/path");
    expect(a).toBe(b);
  });

  it("different paths produce different refs", () => {
    const a = hashUrl("https://example.com/foo");
    const b = hashUrl("https://example.com/bar");
    expect(a).not.toBe(b);
  });

  it("returns url: prefixed string", () => {
    const result = hashUrl("https://example.com/img.png");
    expect(result).toMatch(/^url:/);
  });
});

describe("fetchAndHash", () => {
  it("agrees with hashBase64 for identical bytes", async () => {
    const bytes = Buffer.from("hello world");
    const mockResponse = {
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      )),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await fetchAndHash("https://example.com/img.png");
    expect(result).toBe("sha256:" + SHA256_HELLO_WORLD);

    vi.unstubAllGlobals();
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchAndHash("https://example.com/missing")).rejects.toThrow("404");
    vi.unstubAllGlobals();
  });
});

describe("passthrough", () => {
  it("returns fileid: prefix for fileId source", () => {
    const ref: BinaryRef = {
      kind: "image",
      source: { type: "fileId", fileId: "file_abc", provider: "openai" },
    };
    expect(passthrough(ref)).toBe("fileid:openai:file_abc");
  });

  it("returns base64: prefix for base64 source", () => {
    const ref: BinaryRef = {
      kind: "image",
      source: { type: "base64", data: "aGVsbG8=" },
    };
    expect(passthrough(ref)).toBe("base64:aGVsbG8=");
  });

  it("returns url: prefix for url source", () => {
    const ref: BinaryRef = {
      kind: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    };
    expect(passthrough(ref)).toBe("url:https://example.com/img.png");
  });

  it("returns sha256: for bytes source", () => {
    const ref: BinaryRef = {
      kind: "image",
      source: { type: "bytes", data: Buffer.from("hello") },
    };
    expect(passthrough(ref)).toBe("sha256:" + SHA256_HELLO);
  });
});

describe("composeNormalizer", () => {
  it("routes by source type with defaults (passthrough when no handler)", async () => {
    const normalizer = composeNormalizer();
    const ref: BinaryRef = {
      kind: "image",
      source: { type: "fileId", fileId: "file_xyz", provider: "openai" },
    };
    const result = await normalizer(ref);
    expect(result).toBe("fileid:openai:file_xyz");
  });

  it("uses provided base64 handler when source is base64", async () => {
    const normalizer = composeNormalizer({ base64: hashBase64 });
    const ref: BinaryRef = {
      kind: "image",
      source: { type: "base64", data: "aGVsbG8=" },
    };
    const result = await normalizer(ref);
    expect(result).toBe("sha256:" + SHA256_HELLO);
  });

  it("honors byKind override over source-type dispatch", async () => {
    const kindHandler = vi.fn().mockResolvedValue("kind-result");
    const base64Handler = vi.fn().mockReturnValue("base64-result");

    const normalizer = composeNormalizer({
      base64: base64Handler,
      byKind: { image: kindHandler },
    });

    const ref: BinaryRef = {
      kind: "image",
      source: { type: "base64", data: "aGVsbG8=" },
    };

    const result = await normalizer(ref);
    expect(result).toBe("kind-result");
    expect(kindHandler).toHaveBeenCalledWith(ref);
    expect(base64Handler).not.toHaveBeenCalled();
  });

  it("falls through to source dispatch when byKind does not match kind", async () => {
    const imageHandler = vi.fn().mockResolvedValue("image-result");

    const normalizer = composeNormalizer({
      base64: hashBase64,
      byKind: { image: imageHandler },
    });

    const ref: BinaryRef = {
      kind: "audio",
      source: { type: "base64", data: "aGVsbG8=" },
    };

    const result = await normalizer(ref);
    // audio has no byKind override, falls back to base64 handler
    expect(result).toBe("sha256:" + SHA256_HELLO);
    expect(imageHandler).not.toHaveBeenCalled();
  });
});
