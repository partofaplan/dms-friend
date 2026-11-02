// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_BODY_BYTES,
  type AiErrorResponseBody,
  type ChatStreamEvent,
} from "@/lib/ai/contracts";
import { AiError } from "@/lib/ai/errors";
import type { AiProvider, ChatStreamChunk } from "@/lib/ai/provider";
import { POST } from "./chat/stream/route";

const provider = {
  name: "mock",
  chat: vi.fn<AiProvider["chat"]>(),
  chatStream: vi.fn<AiProvider["chatStream"]>(),
  extractCharacter: vi.fn<AiProvider["extractCharacter"]>(),
};

vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getAiProvider: () => provider,
}));

const SECRET_KEY = "sk-live-super-secret-key-12345";

const validBody = {
  messages: [
    { role: "system", content: "You are a helpful DM assistant." },
    { role: "user", content: "How does grappling work?" },
  ],
};

function post(body: unknown, raw = false): Request {
  return new Request("http://localhost/api/ai/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/** A provider stream that yields `deltas`, then optionally throws `error`. */
async function* deltas(
  items: string[],
  error?: unknown,
): AsyncGenerator<ChatStreamChunk, void, undefined> {
  for (const delta of items) yield { delta };
  if (error) throw error;
}

/** Parses the raw SSE body: one `event:` + `data:` pair per blank-line-separated frame. */
async function readEvents(response: Response): Promise<{ text: string; events: ChatStreamEvent[] }> {
  const text = await response.text();
  const frames = text.split("\n\n").filter(Boolean);
  const events = frames.map((frame) => {
    const [eventLine, dataLine, ...rest] = frame.split("\n");
    expect(rest).toEqual([]);
    const event = JSON.parse(dataLine.replace(/^data: /, "")) as ChatStreamEvent;
    expect(eventLine).toBe(`event: ${event.type}`);
    return event;
  });
  return { text, events };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", SECRET_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  provider.chatStream.mockReset();
});

describe("POST /api/ai/chat/stream", () => {
  it("streams provider deltas as SSE frames ending in done", async () => {
    provider.chatStream.mockReturnValue(deltas(["Make an ", "Athletics ", "check."]));

    const response = await POST(post(validBody));
    const { text, events } = await readEvents(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(text.startsWith('event: delta\ndata: {"type":"delta","delta":"Make an "}\n\n')).toBe(true);
    expect(events).toEqual([
      { type: "delta", delta: "Make an " },
      { type: "delta", delta: "Athletics " },
      { type: "delta", delta: "check." },
      { type: "done" },
    ]);
    expect(provider.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({ messages: validBody.messages, signal: expect.any(AbortSignal) }),
    );
  });

  it("ends a mid-stream failure with a typed error frame and no upstream text", async () => {
    provider.chatStream.mockReturnValue(
      deltas(["Partial "], new AiError("provider_error", `upstream said ${SECRET_KEY}`)),
    );

    const response = await POST(post(validBody));
    const { text, events } = await readEvents(response);

    expect(response.status).toBe(200);
    expect(events).toEqual([
      { type: "delta", delta: "Partial " },
      {
        type: "error",
        error: { kind: "provider_error", message: "The AI provider failed to handle the request." },
      },
    ]);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("upstream said");
  });

  it("maps a non-AiError mid-stream failure to provider_error without leaking", async () => {
    provider.chatStream.mockReturnValue(deltas(["a"], new Error(`socket ${SECRET_KEY}`)));
    const { text, events } = await readEvents(await POST(post(validBody)));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "provider_error" } });
    expect(text).not.toContain(SECRET_KEY);
  });

  it.each([
    ["missing_key", 500],
    ["rate_limited", 429],
    ["timeout", 504],
    ["provider_error", 502],
  ] as const)("returns %s as HTTP %i JSON when the stream fails before any delta", async (kind, status) => {
    provider.chatStream.mockReturnValue(deltas([], new AiError(kind, `detail ${SECRET_KEY}`)));

    const response = await POST(post(validBody));
    const text = await response.text();

    expect(response.status).toBe(status);
    expect((JSON.parse(text) as AiErrorResponseBody).error.kind).toBe(kind);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("detail");
  });

  it("returns invalid_response when the stream ends with no content", async () => {
    provider.chatStream.mockReturnValue(deltas([]));
    const response = await POST(post(validBody));
    expect(response.status).toBe(502);
    expect(((await response.json()) as AiErrorResponseBody).error.kind).toBe("invalid_response");
  });

  it.each([
    ["no messages", { messages: [] }],
    ["bad role", { messages: [{ role: "tool", content: "x" }] }],
    ["temperature out of range", { ...validBody, temperature: 5 }],
  ])("returns 400 for %s without calling the provider", async (_label, body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as AiErrorResponseBody).error.kind).toBe("bad_request");
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await POST(post("{nope", true));
    expect(response.status).toBe(400);
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  it("returns 413 for a body over the chat byte cap without calling the provider", async () => {
    const content = "x".repeat(MAX_CHAT_BODY_BYTES);
    const response = await POST(post({ messages: [{ role: "user", content }] }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { kind: "payload_too_large", message: "The request body is too large." },
    });
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  it("stops the provider stream when the client cancels the response", async () => {
    let finished = false;
    provider.chatStream.mockReturnValue(
      (async function* () {
        try {
          yield { delta: "one" };
          yield { delta: "two" };
          yield { delta: "three" };
        } finally {
          finished = true;
        }
      })(),
    );

    const response = await POST(post(validBody));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(finished).toBe(true);
  });
});

describe("real provider wiring", () => {
  it("reports missing_key as HTTP 500 when OPENAI_API_KEY is unset", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { getAiProvider } = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
    provider.chatStream.mockImplementation((request) => getAiProvider().chatStream(request));

    const response = await POST(post(validBody));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { kind: "missing_key", message: "The AI service is not configured on the server." },
    });
    expect(text).not.toContain("OPENAI_API_KEY");
  });
});
