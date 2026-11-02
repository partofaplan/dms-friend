import type { z } from "zod";
import type { AiErrorKind, AiErrorResponseBody, ChatStreamEvent } from "./contracts";
import { AI_ERROR_HTTP_STATUS, AI_ERROR_PUBLIC_MESSAGE, isAiError } from "./errors";
import type { ChatStreamChunk } from "./provider";

/* Shared helpers for the /api/ai/* route handlers. */

function errorJson(
  kind: AiErrorKind,
  message: string,
  status: number,
  issues?: AiErrorResponseBody["error"]["issues"],
): Response {
  const body: AiErrorResponseBody = { error: { kind, message, ...(issues && { issues }) } };
  return Response.json(body, { status });
}

export class RequestBodyError extends Error {
  readonly reason: "too_large" | "invalid_json";

  constructor(reason: RequestBodyError["reason"], options?: { cause?: unknown }) {
    super(reason === "too_large" ? "Request body exceeds the size limit" : "Request body is not valid JSON", options);
    this.name = "RequestBodyError";
    this.reason = reason;
  }
}

/**
 * Reads and parses a JSON request body, never buffering more than `maxBytes`.
 * A declared Content-Length over the cap is rejected before reading; bodies
 * without one (chunked/streamed) are counted as they arrive and the stream is
 * cancelled as soon as the cap is crossed.
 *
 * @throws RequestBodyError `too_large` or `invalid_json`.
 */
export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new RequestBodyError("too_large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyError("too_large");
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new RequestBodyError("invalid_json", { cause: error });
  }
}

/**
 * Reads (capped at `maxBytes`), parses, and validates a JSON request body.
 * Returns a 413 response when oversized and a 400 when malformed or invalid.
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
  let json: unknown;
  try {
    json = await readJsonWithLimit(request, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyError && error.reason === "too_large") {
      return {
        ok: false,
        response: errorJson(
          "payload_too_large",
          AI_ERROR_PUBLIC_MESSAGE.payload_too_large,
          AI_ERROR_HTTP_STATUS.payload_too_large,
        ),
      };
    }
    return {
      ok: false,
      response: errorJson("bad_request", "Request body must be valid JSON.", 400),
    };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return {
      ok: false,
      response: errorJson("bad_request", "Request body is invalid.", 400, issues),
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Reduces a thrown error to its kind and fixed public message, logging
 * upstream details server-side by kind/status only.
 */
function publicAiError(error: unknown, route: string): { kind: AiErrorKind; message: string } {
  const kind: AiErrorKind = isAiError(error) ? error.kind : "provider_error";
  // AiError messages are written by us and never contain secrets.
  const detail = isAiError(error) ? error.message : "non-AiError thrown";
  console.error(`[${route}] AI request failed (${kind}): ${detail}`);
  return { kind, message: AI_ERROR_PUBLIC_MESSAGE[kind] };
}

/**
 * Maps a thrown error to a safe JSON response. Only fixed public messages are
 * returned; upstream details are logged server-side by kind/status only.
 */
export function aiErrorResponse(error: unknown, route: string): Response {
  const { kind, message } = publicAiError(error, route);
  return errorJson(kind, message, AI_ERROR_HTTP_STATUS[kind]);
}

/** Serializes one SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function encodeChatStreamEvent(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * An AbortController owned by a streaming route. It aborts when the incoming
 * request's signal does, and the route aborts it itself when the response is
 * cancelled; the provider gets `controller.signal`, so either event tears
 * down the upstream request.
 */
export function upstreamAbortController(requestSignal: AbortSignal): AbortController {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) {
    onRequestAbort();
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    // However we end up aborted, drop the listener so it can't leak.
    controller.signal.addEventListener(
      "abort",
      () => requestSignal.removeEventListener("abort", onRequestAbort),
      { once: true },
    );
  }
  return controller;
}

/**
 * Wraps an already-started chat stream as a Server-Sent Events response.
 * `first` is the delta the caller pulled to confirm the stream started (so
 * setup failures could still become normal JSON error responses). Each later
 * delta is pulled on demand; completion sends `done`, and a failure sends one
 * `error` frame with the fixed public message — never upstream text — before
 * closing. `upstream` must own the signal the provider stream was started
 * with: cancelling the response (client disconnect) aborts it, which
 * interrupts even a read blocked on the upstream — iterator.return() alone
 * would queue behind that pending next().
 */
export function chatStreamResponse(
  first: ChatStreamChunk,
  iterator: AsyncIterator<ChatStreamChunk>,
  upstream: AbortController,
  route: string,
): Response {
  const encoder = new TextEncoder();
  let pending: ChatStreamChunk | undefined = first;
  let cancelled = false;
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: ChatStreamEvent) =>
    controller.enqueue(encoder.encode(encodeChatStreamEvent(event)));

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        send(controller, { type: "delta", delta: pending.delta });
        pending = undefined;
        return;
      }
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) {
          upstream.abort(); // Already finished; this just releases the request listener.
          send(controller, { type: "done" });
          controller.close();
        } else {
          send(controller, { type: "delta", delta: next.value.delta });
        }
      } catch (error) {
        // After a cancel there is no reader left, and the abort is expected.
        if (cancelled) return;
        upstream.abort();
        send(controller, { type: "error", error: publicAiError(error, route) });
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      // Abort first, so a blocked upstream read is interrupted. Then end the
      // iterator without awaiting: return() settles only after a pending
      // next() does.
      upstream.abort();
      Promise.resolve(iterator.return?.()).catch(() => {});
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
