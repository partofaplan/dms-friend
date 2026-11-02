import {
  AI_ERROR_KINDS,
  CHAT_STREAM_ENDPOINT,
  type AiErrorKind,
  type AiErrorResponseBody,
  type ChatMessage,
  type ChatRequestBody,
  type ChatStreamEvent,
} from "@/lib/ai/contracts";

/*
 * Browser-side call to POST /api/ai/chat/stream. Reads the SSE frames as they
 * arrive, reporting each text delta, and reduces failures to an error kind
 * plus a fixed, friendly message — server/provider text is never shown.
 */

/** Server error kinds, plus failures that happen before/without a response. */
export type ChatErrorKind = AiErrorKind | "network";

export const CHAT_ERROR_MESSAGES: Record<ChatErrorKind, string> = {
  missing_key: "AI isn't configured on this server, so the assistant can't answer.",
  rate_limited: "The AI is busy right now. Try again in a moment.",
  timeout: "The AI took too long to answer. Try again.",
  provider_error: "The AI couldn't answer right now. Try again.",
  invalid_response: "The AI's answer came back empty or garbled. Try again.",
  bad_request: "That message couldn't be sent. Try rephrasing, or clear the conversation.",
  payload_too_large: "The conversation is too long to send. Clear it and try again.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

export type StreamChatResult =
  | { ok: true; text: string }
  | {
      ok: false;
      kind: ChatErrorKind;
      message: string;
      /** True when some of the reply arrived before the failure. */
      interrupted: boolean;
      /** Whatever text arrived before the failure. */
      text: string;
    };

export interface StreamChatOptions {
  /** Called with each text delta as it arrives. */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
}

function isAiErrorKind(value: unknown): value is AiErrorKind {
  return (AI_ERROR_KINDS as readonly unknown[]).includes(value);
}

/** Fallback when the error body is missing or unrecognized. */
function kindFromStatus(status: number): AiErrorKind {
  if (status === 400) return "bad_request";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 504) return "timeout";
  return "provider_error";
}

function parseEvent(data: string): ChatStreamEvent | null {
  try {
    const event = JSON.parse(data) as Partial<ChatStreamEvent> | null;
    if (event?.type === "delta" && typeof event.delta === "string") return event as ChatStreamEvent;
    if (event?.type === "done") return { type: "done" };
    if (event?.type === "error") {
      const kind = (event as { error?: { kind?: unknown } }).error?.kind;
      const safeKind = isAiErrorKind(kind) ? kind : "provider_error";
      return { type: "error", error: { kind: safeKind, message: CHAT_ERROR_MESSAGES[safeKind] } };
    }
  } catch {
    // Ignore malformed frames.
  }
  return null;
}

/**
 * Incremental SSE parser: feed decoded text in arbitrary pieces and get back
 * the complete events seen so far. Only `data:` lines are used; the JSON
 * payload carries the event type.
 */
export function createSseParser(): (text: string) => ChatStreamEvent[] {
  let buffer = "";
  // A trailing "\r" may be the first half of a CRLF split across chunks, so
  // it is held back until the next chunk shows whether "\n" follows.
  let carriageReturn = false;
  return (text) => {
    let input = (carriageReturn ? "\r" : "") + text;
    carriageReturn = input.endsWith("\r");
    if (carriageReturn) input = input.slice(0, -1);
    buffer += input.replace(/\r\n?/g, "\n");
    const events: ChatStreamEvent[] = [];
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      const event = data ? parseEvent(data) : null;
      if (event) events.push(event);
    }
    return events;
  };
}

/**
 * Streams one assistant reply. Resolves with the full text or a classified
 * failure (keeping any partial text); rejects only when `signal` aborts.
 */
export async function streamChat(
  messages: ChatMessage[],
  { onDelta, signal, fetchImpl = fetch, temperature, maxTokens }: StreamChatOptions = {},
): Promise<StreamChatResult> {
  const body: ChatRequestBody = { messages, temperature, maxTokens };
  let text = "";
  const fail = (kind: ChatErrorKind): StreamChatResult => ({
    ok: false,
    kind,
    message: CHAT_ERROR_MESSAGES[kind],
    interrupted: text.length > 0,
    text,
  });

  let response: Response;
  try {
    response = await fetchImpl(CHAT_STREAM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("network");
  }

  if (!response.ok) {
    let kind: unknown;
    try {
      kind = ((await response.json()) as Partial<AiErrorResponseBody>).error?.kind;
    } catch {
      // Fall back to the status below.
    }
    return fail(isAiErrorKind(kind) ? kind : kindFromStatus(response.status));
  }
  if (!response.body) return fail("invalid_response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const events = parse(done ? decoder.decode() + "\n\n" : decoder.decode(value, { stream: true }));
      for (const event of events) {
        if (event.type === "delta") {
          text += event.delta;
          onDelta?.(event.delta);
        } else if (event.type === "done") {
          return text ? { ok: true, text } : fail("invalid_response");
        } else {
          return fail(event.error.kind);
        }
      }
      // The stream closed without a `done` frame: the reply was cut off.
      if (done) return fail(text ? "network" : "invalid_response");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("network");
  } finally {
    reader.cancel().catch(() => {});
  }
}
