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

export const chatMessageSchema = z.object({
  role: z.enum(CHAT_ROLES),
  content: z.string().min(1, "content is required").max(32_000),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, "at least one message is required").max(100),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
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
