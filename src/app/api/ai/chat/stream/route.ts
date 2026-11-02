import { AiError, getAiProvider, type ChatStreamChunk } from "@/lib/ai";
import { chatRequestSchema, MAX_CHAT_BODY_BYTES } from "@/lib/ai/contracts";
import { aiErrorResponse, chatStreamResponse, parseJsonBody } from "@/lib/ai/http";

// Server-only: reads OPENAI_API_KEY per request, never at build time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "api/ai/chat/stream";

/**
 * POST /api/ai/chat/stream
 * Body: ChatRequestBody (same schema and byte cap as /api/ai/chat).
 * → 200 text/event-stream of ChatStreamEvent frames, or AiErrorResponseBody
 *   (with the usual status) when the request fails before the first delta.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, chatRequestSchema, MAX_CHAT_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  // Pull the first delta before committing to a 200 stream, so setup failures
  // (missing key, rate limit, bad upstream status) keep their HTTP status.
  let iterator: AsyncIterator<ChatStreamChunk>;
  let first: IteratorResult<ChatStreamChunk>;
  try {
    iterator = getAiProvider()
      .chatStream({ ...parsed.data, signal: request.signal })
      [Symbol.asyncIterator]();
    first = await iterator.next();
  } catch (error) {
    return aiErrorResponse(error, ROUTE);
  }
  if (first.done) {
    return aiErrorResponse(new AiError("invalid_response", "Chat stream produced no content"), ROUTE);
  }
  return chatStreamResponse(first.value, iterator, ROUTE);
}
