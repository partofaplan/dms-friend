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
