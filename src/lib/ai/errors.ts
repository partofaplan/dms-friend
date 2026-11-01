import type { AiErrorKind } from "./contracts";

export type { AiErrorKind } from "./contracts";

/**
 * A provider-agnostic AI failure. Providers translate their own SDK/network
 * errors into one of these kinds so callers never depend on provider details.
 */
export class AiError extends Error {
  readonly kind: AiErrorKind;

  constructor(kind: AiErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiError";
    this.kind = kind;
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError;
}

/** HTTP status returned by the API routes for each error kind. */
export const AI_ERROR_HTTP_STATUS: Record<AiErrorKind, number> = {
  bad_request: 400,
  rate_limited: 429,
  missing_key: 500,
  provider_error: 502,
  invalid_response: 502,
  timeout: 504,
};

/**
 * Client-facing messages. Fixed strings so upstream error text (which can
 * include masked keys, org ids, or request ids) never reaches the client.
 */
export const AI_ERROR_PUBLIC_MESSAGE: Record<AiErrorKind, string> = {
  bad_request: "The AI request was invalid.",
  rate_limited: "The AI provider is rate limiting requests. Try again shortly.",
  missing_key: "The AI service is not configured on the server.",
  provider_error: "The AI provider failed to handle the request.",
  invalid_response: "The AI provider returned an unusable response.",
  timeout: "The AI provider took too long to respond.",
};
