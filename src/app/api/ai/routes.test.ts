// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_BODY_BYTES,
  MAX_EXTRACT_BODY_BYTES,
  MAX_IMAGE_BASE64_LENGTH,
  type AiErrorResponseBody,
} from "@/lib/ai/contracts";
import { AiError } from "@/lib/ai/errors";
import type { AiProvider } from "@/lib/ai/provider";
import { POST as chatPOST } from "./chat/route";
import { POST as extractPOST } from "./extract/route";

const provider = {
  name: "mock",
  chat: vi.fn<AiProvider["chat"]>(),
  extractCharacter: vi.fn<AiProvider["extractCharacter"]>(),
};

vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getAiProvider: () => provider,
}));

const SECRET_KEY = "sk-live-super-secret-key-12345";

function post(body: unknown, raw = false): Request {
  return new Request("http://localhost/api/ai/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/** A POST whose body arrives as a chunked stream with no Content-Length. */
function postStream(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://localhost/api/ai/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

async function expectPayloadTooLarge(response: Response): Promise<void> {
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { kind: "payload_too_large", message: "The request body is too large." },
  });
}

async function readBody(response: Response): Promise<{ text: string; json: unknown }> {
  const text = await response.text();
  return { text, json: JSON.parse(text) };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", SECRET_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  provider.chat.mockReset();
  provider.extractCharacter.mockReset();
});

describe("POST /api/ai/chat", () => {
  const validBody = {
    messages: [
      { role: "system", content: "You are a helpful DM assistant." },
      { role: "user", content: "How does grappling work?" },
    ],
    temperature: 0.3,
  };

  it("returns the assistant reply", async () => {
    provider.chat.mockResolvedValue({ reply: "Make an Athletics check.", usage: { inputTokens: 5, outputTokens: 4 } });

    const response = await chatPOST(post(validBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reply: "Make an Athletics check.",
      usage: { inputTokens: 5, outputTokens: 4 },
    });
    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ messages: validBody.messages, temperature: 0.3 }),
    );
  });

  it.each([
    ["no messages", { messages: [] }],
    ["bad role", { messages: [{ role: "tool", content: "x" }] }],
    ["empty content", { messages: [{ role: "user", content: "" }] }],
    ["temperature out of range", { ...validBody, temperature: 5 }],
    ["not an object", ["hello"]],
  ])("returns 400 for %s", async (_label, body) => {
    const response = await chatPOST(post(body));
    expect(response.status).toBe(400);
    const json = (await response.json()) as AiErrorResponseBody;
    expect(json.error.kind).toBe("bad_request");
    expect(json.error.issues?.length).toBeGreaterThan(0);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await chatPOST(post("{not json", true));
    expect(response.status).toBe(400);
    expect(((await response.json()) as AiErrorResponseBody).error.kind).toBe("bad_request");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body without calling the provider", async () => {
    const content = "x".repeat(MAX_CHAT_BODY_BYTES);
    const response = await chatPOST(post({ messages: [{ role: "user", content }] }));
    await expectPayloadTooLarge(response);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized chunked body with no Content-Length", async () => {
    const chunk = "x".repeat(256 * 1024);
    const chunks = ['{"messages":[{"role":"user","content":"'];
    for (let i = 0; i * chunk.length <= MAX_CHAT_BODY_BYTES; i++) chunks.push(chunk);
    chunks.push('"}]}');

    const response = await chatPOST(postStream(chunks));
    await expectPayloadTooLarge(response);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns 413 when Content-Length declares an oversized body", async () => {
    const request = new Request("http://localhost/api/ai/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_CHAT_BODY_BYTES + 1) },
      body: JSON.stringify(validBody),
    });
    await expectPayloadTooLarge(await chatPOST(request));
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it.each([
    ["missing_key", 500],
    ["provider_error", 502],
    ["invalid_response", 502],
    ["bad_request", 400],
    ["rate_limited", 429],
    ["timeout", 504],
  ] as const)("maps %s to HTTP %i without leaking the key", async (kind, status) => {
    provider.chat.mockRejectedValue(
      new AiError(kind, `internal detail mentioning ${SECRET_KEY}`),
    );

    const response = await chatPOST(post(validBody));
    const { text, json } = await readBody(response);

    expect(response.status).toBe(status);
    expect((json as AiErrorResponseBody).error.kind).toBe(kind);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("internal detail");
  });

  it("returns 502 for a non-AiError failure", async () => {
    provider.chat.mockRejectedValue(new Error(`boom ${SECRET_KEY}`));
    const response = await chatPOST(post(validBody));
    const { text } = await readBody(response);
    expect(response.status).toBe(502);
    expect(text).not.toContain(SECRET_KEY);
  });
});

describe("POST /api/ai/extract", () => {
  const extracted = { name: "Lia", className: "Bard", level: 3 };

  it("accepts a data URL and returns the parsed data", async () => {
    provider.extractCharacter.mockResolvedValue({ data: extracted, raw: JSON.stringify(extracted) });

    const response = await extractPOST(post({ imageDataUrl: "data:image/jpeg;base64,aGVsbG8=" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: extracted, raw: JSON.stringify(extracted) });
    expect(provider.extractCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ image: { base64: "aGVsbG8=", mimeType: "image/jpeg" } }),
    );
  });

  it("accepts raw base64 plus mime type", async () => {
    provider.extractCharacter.mockResolvedValue({ data: extracted, raw: "{}" });

    const response = await extractPOST(post({ imageBase64: "aGVsbG8=", mimeType: "image/png" }));

    expect(response.status).toBe(200);
    expect(provider.extractCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ image: { base64: "aGVsbG8=", mimeType: "image/png" } }),
    );
  });

  it.each([
    ["missing image", {}],
    ["not a data URL", { imageDataUrl: "https://example.com/sheet.png" }],
    ["unsupported type", { imageDataUrl: "data:image/svg+xml;base64,aGVsbG8=" }],
    ["non-base64 data", { imageBase64: "not base64!", mimeType: "image/png" }],
    ["unsupported mime type", { imageBase64: "aGVsbG8=", mimeType: "application/pdf" }],
  ])("returns 400 for %s", async (_label, body) => {
    const response = await extractPOST(post(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as AiErrorResponseBody).error.kind).toBe("bad_request");
    expect(provider.extractCharacter).not.toHaveBeenCalled();
  });

  it("accepts a max-size image without tripping the body limit", async () => {
    provider.extractCharacter.mockResolvedValue({ data: extracted, raw: "{}" });
    const base64 = "A".repeat(MAX_IMAGE_BASE64_LENGTH);

    const response = await extractPOST(post({ imageDataUrl: `data:image/png;base64,${base64}` }));

    expect(response.status).toBe(200);
    expect(provider.extractCharacter).toHaveBeenCalledTimes(1);
  });

  it("returns 413 for a body over the extract limit without calling the provider", async () => {
    const base64 = "A".repeat(MAX_EXTRACT_BODY_BYTES);

    const response = await extractPOST(post({ imageBase64: base64, mimeType: "image/png" }));

    await expectPayloadTooLarge(response);
    expect(provider.extractCharacter).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await extractPOST(post('{"imageDataUrl": ', true));
    expect(response.status).toBe(400);
    expect(((await response.json()) as AiErrorResponseBody).error.kind).toBe("bad_request");
    expect(provider.extractCharacter).not.toHaveBeenCalled();
  });

  it("returns 500 for missing_key without leaking the key", async () => {
    provider.extractCharacter.mockRejectedValue(new AiError("missing_key", "OPENAI_API_KEY is not set"));

    const response = await extractPOST(post({ imageDataUrl: "data:image/png;base64,aGVsbG8=" }));
    const { text, json } = await readBody(response);

    expect(response.status).toBe(500);
    expect((json as AiErrorResponseBody).error.kind).toBe("missing_key");
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("OPENAI_API_KEY");
  });
});

describe("real provider wiring", () => {
  it("getAiProvider reports missing_key when OPENAI_API_KEY is unset", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { getAiProvider } = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
    const error = await getAiProvider()
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("missing_key");
  });
});
