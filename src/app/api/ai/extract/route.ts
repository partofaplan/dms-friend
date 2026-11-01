import { getAiProvider } from "@/lib/ai";
import { extractRequestSchema, type ExtractResponseBody } from "@/lib/ai/contracts";
import { aiErrorResponse, parseJsonBody } from "@/lib/ai/http";

// Server-only: reads OPENAI_API_KEY per request, never at build time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/extract
 * Body: ExtractRequestBody → 200 ExtractResponseBody, or AiErrorResponseBody on failure.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, extractRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await getAiProvider().extractCharacter({
      image: parsed.data,
      signal: request.signal,
    });
    const body: ExtractResponseBody = { data: result.data, raw: result.raw, usage: result.usage };
    return Response.json(body);
  } catch (error) {
    return aiErrorResponse(error, "api/ai/extract");
  }
}
