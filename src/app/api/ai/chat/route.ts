import { getAiProvider } from "@/lib/ai";
import { chatRequestSchema, type ChatResponseBody } from "@/lib/ai/contracts";
import { aiErrorResponse, parseJsonBody } from "@/lib/ai/http";

// Server-only: reads OPENAI_API_KEY per request, never at build time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/chat
 * Body: ChatRequestBody → 200 ChatResponseBody, or AiErrorResponseBody on failure.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, chatRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await getAiProvider().chat({ ...parsed.data, signal: request.signal });
    const body: ChatResponseBody = { reply: result.reply, usage: result.usage };
    return Response.json(body);
  } catch (error) {
    return aiErrorResponse(error, "api/ai/chat");
  }
}
