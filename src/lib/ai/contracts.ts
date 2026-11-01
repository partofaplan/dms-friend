import { z } from "zod";

/*
 * Request/response contracts for the /api/ai/* route handlers.
 *
 * This module is safe to import from client code: it only depends on Zod and
 * contains no server logic, provider code, or environment access.
 */

export const CHAT_ROLES = ["system", "user", "assistant"] as const;

export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/** Upper bound on base64 payload length (~15 MB of base64 ≈ 11 MB image). */
export const MAX_IMAGE_BASE64_LENGTH = 15_000_000;

/** Max messages per chat request. */
export const MAX_CHAT_MESSAGES = 100;

/** Max `content` length per chat message, in UTF-16 code units (Zod's string length). */
export const MAX_MESSAGE_CONTENT_LENGTH = 32_000;

/*
 * Request body byte caps, enforced while the body is streamed in (before JSON
 * parsing) so oversized payloads are rejected with 413 without being buffered.
 * Each cap must admit every body its schema accepts.
 */

/** Headroom for the JSON wrapper, field names, and data URL prefix. */
const BODY_ENVELOPE_BYTES = 64 * 1024;

/** /api/ai/extract: one max-size base64 image (ASCII, 1 byte/char) plus envelope. */
export const MAX_EXTRACT_BODY_BYTES = MAX_IMAGE_BASE64_LENGTH + BODY_ENVELOPE_BYTES;

/*
 * Worst-case JSON bytes per UTF-16 code unit of a string value. A code unit can
 * always be written as a `\uXXXX` escape (6 bytes) — JSON.stringify does this
 * for control chars and lone surrogates, and any client may do it for any char.
 * Unescaped text is at most 3 bytes/unit (BMP, e.g. "界") or 2 (surrogate pairs:
 * 4 bytes per 2 units), so 6 bounds every encoding.
 */
const MAX_JSON_BYTES_PER_CHAR = 6;

/** Per-message structure: `{"role":"assistant","content":""},` is 34 bytes. */
const CHAT_MESSAGE_OVERHEAD_BYTES = 64;

/**
 * /api/ai/chat: transport-layer byte cap on the request body, enforced while
 * streaming so oversized payloads are rejected (413) before being buffered or
 * parsed. It is a DoS guard, NOT a restatement of schema validity: JSON numbers
 * and whitespace have unbounded length, so no finite byte cap can admit *every*
 * syntactically schema-valid body. The cap is instead sized to the largest
 * body a real client sends — max messages × (max content × worst-case bytes per
 * char + per-message structure) + envelope (≈ 18.4 MiB) — derived from the
 * schema limits so ordinary message content never trips it. This is a raw-byte
 * guard applied BEFORE JSON.parse; it does not — and cannot — track parsed-value
 * validity, since a client may pad a number literal or whitespace to any size
 * and those bytes vanish at parse time (e.g. 0.000…01 underflows to 0). Such an
 * abusive payload is correctly rejected with 413 at this layer rather than being
 * buffered and parsed.
 */
export const MAX_CHAT_BODY_BYTES =
  MAX_CHAT_MESSAGES *
    (MAX_MESSAGE_CONTENT_LENGTH * MAX_JSON_BYTES_PER_CHAR + CHAT_MESSAGE_OVERHEAD_BYTES) +
  BODY_ENVELOPE_BYTES;

export const chatMessageSchema = z.object({
  role: z.enum(CHAT_ROLES),
  content: z.string().min(1, "content is required").max(MAX_MESSAGE_CONTENT_LENGTH),
});

/*
 * Keep the numeric fields' *parsed values* well-formed (a sane precision, not an
 * arbitrary float). This does NOT bound the raw serialized width — JSON.parse has
 * already discarded any padding before Zod runs — that's the transport cap's job
 * above. It just rejects nonsense like temperature: 0.123456 with a clear 400.
 */
const boundedProbability = z
  .number()
  .min(0)
  .max(2)
  .multipleOf(0.01, "temperature must have at most two decimal places");

const boundedTokenBudget = z.number().int().min(1).max(4096);

export const chatRequestSchema = z.object({
  messages: z
    .array(chatMessageSchema)
    .min(1, "at least one message is required")
    .max(MAX_CHAT_MESSAGES),
  temperature: boundedProbability.optional(),
  maxTokens: boundedTokenBudget.optional(),
});

const imageMimeTypeSchema = z.enum(SUPPORTED_IMAGE_TYPES);

const base64Schema = z
  .string()
  .min(1, "image data is required")
  .max(MAX_IMAGE_BASE64_LENGTH, "image is too large")
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "image data must be base64");

const DATA_URL_PATTERN = /^data:(image\/[a-z+.-]+);base64,(.*)$/;

/**
 * An extraction request carries the image either as a data URL
 * (`data:image/png;base64,...`) or as raw base64 plus its mime type.
 * Both forms are normalized to `{ base64, mimeType }`.
 */
export const extractRequestSchema = z
  .union([
    z.object({ imageDataUrl: z.string() }),
    z.object({ imageBase64: z.string(), mimeType: z.string() }),
  ])
  .transform((body, ctx) => {
    let mimeType: string;
    let base64: string;
    if ("imageDataUrl" in body) {
      const match = DATA_URL_PATTERN.exec(body.imageDataUrl);
      if (!match) {
        ctx.addIssue({
          code: "custom",
          path: ["imageDataUrl"],
          message: "imageDataUrl must be a base64 image data URL",
        });
        return z.NEVER;
      }
      [, mimeType, base64] = match;
    } else {
      mimeType = body.mimeType;
      base64 = body.imageBase64;
    }

    const type = imageMimeTypeSchema.safeParse(mimeType);
    if (!type.success) {
      ctx.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: `mimeType must be one of ${SUPPORTED_IMAGE_TYPES.join(", ")}`,
      });
      return z.NEVER;
    }
    const data = base64Schema.safeParse(base64);
    if (!data.success) {
      ctx.addIssue({
        code: "custom",
        path: ["image"],
        message: data.error.issues[0]?.message ?? "invalid image data",
      });
      return z.NEVER;
    }
    return { mimeType: type.data, base64: data.data };
  });

export type ChatRole = (typeof CHAT_ROLES)[number];
export type ImageMimeType = (typeof SUPPORTED_IMAGE_TYPES)[number];
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** POST /api/ai/chat request body. */
export type ChatRequestBody = z.input<typeof chatRequestSchema>;
/** POST /api/ai/extract request body. */
export type ExtractRequestBody = z.input<typeof extractRequestSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** POST /api/ai/chat 200 response body. */
export interface ChatResponseBody {
  reply: string;
  usage?: TokenUsage;
}

/**
 * POST /api/ai/extract 200 response body. `data` is the model's JSON, shaped
 * like the Character model but NOT validated against it — callers map and
 * validate it with the Zod character schema.
 */
export interface ExtractResponseBody {
  data: Record<string, unknown>;
  raw: string;
  usage?: TokenUsage;
}

export const AI_ERROR_KINDS = [
  "missing_key",
  "bad_request",
  "payload_too_large",
  "rate_limited",
  "timeout",
  "provider_error",
  "invalid_response",
] as const;

export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/** Body of every non-2xx response from /api/ai/*. */
export interface AiErrorResponseBody {
  error: {
    kind: AiErrorKind;
    message: string;
    /** Present on request validation failures. */
    issues?: { path: string; message: string }[];
  };
}
