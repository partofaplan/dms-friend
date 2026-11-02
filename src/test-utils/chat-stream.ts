import type { AiErrorKind, ChatStreamEvent } from "@/lib/ai/contracts";

/**
 * A controllable /api/ai/chat/stream response for tests: frames are pushed
 * on demand, so a test can assert on the UI between deltas.
 */
export function controllableChatStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const push = (event: ChatStreamEvent) =>
    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));

  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    /** Pushes raw bytes, e.g. half a frame. */
    raw(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    delta(delta: string) {
      push({ type: "delta", delta });
    },
    done() {
      push({ type: "done" });
      controller.close();
    },
    fail(kind: AiErrorKind, message = "server message") {
      push({ type: "error", error: { kind, message } });
      controller.close();
    },
    /** Ends the stream with no terminal frame (a dropped connection). */
    close() {
      controller.close();
    },
  };
}

export function aiErrorJson(kind: AiErrorKind, status: number): Response {
  return new Response(JSON.stringify({ error: { kind, message: "server message" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
