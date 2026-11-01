import type { z } from "zod";
import type { AiErrorKind, AiErrorResponseBody } from "./contracts";
import { AI_ERROR_HTTP_STATUS, AI_ERROR_PUBLIC_MESSAGE, isAiError } from "./errors";

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

/** Parses and validates a JSON request body, or returns a 400 response. */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
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
 * Maps a thrown error to a safe JSON response. Only fixed public messages are
 * returned; upstream details are logged server-side by kind/status only.
 */
export function aiErrorResponse(error: unknown, route: string): Response {
  const kind: AiErrorKind = isAiError(error) ? error.kind : "provider_error";
  // AiError messages are written by us and never contain secrets.
  const detail = isAiError(error) ? error.message : "non-AiError thrown";
  console.error(`[${route}] AI request failed (${kind}): ${detail}`);
  return errorJson(kind, AI_ERROR_PUBLIC_MESSAGE[kind], AI_ERROR_HTTP_STATUS[kind]);
}
