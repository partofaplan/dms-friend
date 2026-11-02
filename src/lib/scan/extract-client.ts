import {
  AI_ERROR_KINDS,
  type AiErrorKind,
  type AiErrorResponseBody,
  type ExtractRequestBody,
  type ExtractResponseBody,
} from "@/lib/ai/contracts";

/*
 * Browser-side call to POST /api/ai/extract. Failures are reduced to an error
 * kind plus a fixed, friendly message — server/provider message text is never
 * shown to the user.
 */

export const EXTRACT_ENDPOINT = "/api/ai/extract";

/** Server error kinds, plus failures that happen before a response arrives. */
export type ScanErrorKind = AiErrorKind | "network";

export type ExtractResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; kind: ScanErrorKind; message: string };

export const SCAN_ERROR_MESSAGES: Record<ScanErrorKind, string> = {
  missing_key:
    "AI isn't configured on this server, so sheets can't be read. You can enter the character manually.",
  rate_limited: "The AI is busy right now. Try again in a moment.",
  timeout: "That took too long. Try again, or use a smaller image.",
  payload_too_large: "That image is too large. Try a smaller photo.",
  bad_request:
    "That image couldn't be sent. Try a different photo (PNG, JPEG, WebP, or GIF).",
  provider_error:
    "The AI couldn't read that sheet. Try again, or use a clearer photo.",
  invalid_response:
    "The AI's answer didn't make sense. Try again, or use a clearer photo.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

function failure(kind: ScanErrorKind): ExtractResult {
  return { ok: false, kind, message: SCAN_ERROR_MESSAGES[kind] };
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Sends a base64 image data URL for extraction. Resolves with the raw
 * (unvalidated) data or a classified failure; rejects only on abort.
 */
export async function extractCharacter(
  imageDataUrl: string,
  { signal, fetchImpl = fetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ExtractResult> {
  const body: ExtractRequestBody = { imageDataUrl };
  let response: Response;
  try {
    response = await fetchImpl(EXTRACT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return failure("network");
  }

  const json = await readJson(response);
  if (!response.ok) {
    const kind = (json as Partial<AiErrorResponseBody> | undefined)?.error?.kind;
    return failure(isAiErrorKind(kind) ? kind : kindFromStatus(response.status));
  }

  const data = (json as Partial<ExtractResponseBody> | undefined)?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return failure("invalid_response");
  }
  return { ok: true, data };
}
