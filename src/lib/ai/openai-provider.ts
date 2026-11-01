import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {
  CHARACTER_EXTRACTION_SCHEMA_NAME,
  CHARACTER_EXTRACTION_SYSTEM_PROMPT,
  CHARACTER_EXTRACTION_USER_PROMPT,
  characterExtractionJsonSchema,
} from "./character-extraction";
import type { TokenUsage } from "./contracts";
import { AiError } from "./errors";
import type {
  AiProvider,
  ChatRequest,
  ChatResult,
  ExtractCharacterRequest,
  ExtractCharacterResult,
} from "./provider";

export const DEFAULT_OPENAI_MODEL = "gpt-4o";
/** Per-attempt upstream timeout. Vision calls on large photos can take a while. */
export const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;
const EXTRACTION_MAX_TOKENS = 2048;

type ChatCompletionsClient = {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): PromiseLike<ChatCompletion>;
    };
  };
};

export interface OpenAiProviderOptions {
  /** Missing/empty keys are reported as a `missing_key` AiError at call time. */
  apiKey: string | undefined;
  model?: string;
  timeoutMs?: number;
  /** Injection point for tests; defaults to the official SDK client. */
  createClient?: (config: { apiKey: string; timeoutMs: number }) => ChatCompletionsClient;
}

const createSdkClient: NonNullable<OpenAiProviderOptions["createClient"]> = ({
  apiKey,
  timeoutMs,
}) => new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: MAX_RETRIES });

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly createClient: NonNullable<OpenAiProviderOptions["createClient"]>;
  private client: ChatCompletionsClient | undefined;

  constructor(options: OpenAiProviderOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model?.trim() || DEFAULT_OPENAI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
    this.createClient = options.createClient ?? createSdkClient;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const completion = await this.complete(
      {
        model: this.model,
        messages: request.messages,
        temperature: request.temperature,
        max_completion_tokens: request.maxTokens,
      },
      request.signal,
    );
    const message = completion.choices[0]?.message;
    if (!message?.content) {
      throw new AiError("invalid_response", "OpenAI returned no chat content");
    }
    return { reply: message.content, usage: toUsage(completion) };
  }

  async extractCharacter(request: ExtractCharacterRequest): Promise<ExtractCharacterResult> {
    const { base64, mimeType } = request.image;
    const completion = await this.complete(
      {
        model: this.model,
        temperature: 0,
        max_completion_tokens: EXTRACTION_MAX_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: CHARACTER_EXTRACTION_SCHEMA_NAME,
            strict: true,
            schema: characterExtractionJsonSchema,
          },
        },
        messages: [
          { role: "system", content: CHARACTER_EXTRACTION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: CHARACTER_EXTRACTION_USER_PROMPT },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
              },
            ],
          },
        ],
      },
      request.signal,
    );

    const message = completion.choices[0]?.message;
    if (message?.refusal) {
      throw new AiError("invalid_response", "OpenAI refused the extraction request");
    }
    const raw = message?.content;
    if (!raw) {
      throw new AiError("invalid_response", "OpenAI returned no extraction content");
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new AiError("invalid_response", "OpenAI returned invalid JSON", { cause: error });
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new AiError("invalid_response", "OpenAI returned JSON that is not an object");
    }
    return { data: data as Record<string, unknown>, raw, usage: toUsage(completion) };
  }

  private async complete(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
  ): Promise<ChatCompletion> {
    if (!this.apiKey) {
      throw new AiError("missing_key", "OPENAI_API_KEY is not set");
    }
    this.client ??= this.createClient({ apiKey: this.apiKey, timeoutMs: this.timeoutMs });
    try {
      return await this.client.chat.completions.create(body, { signal });
    } catch (error) {
      throw toAiError(error);
    }
  }
}

function toUsage(completion: ChatCompletion): TokenUsage | undefined {
  if (!completion.usage) return undefined;
  return {
    inputTokens: completion.usage.prompt_tokens,
    outputTokens: completion.usage.completion_tokens,
  };
}

/** Translates OpenAI SDK/network failures into provider-agnostic AiErrors. */
export function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  // Order matters: the timeout/abort/connection errors all extend APIError.
  if (error instanceof APIConnectionTimeoutError) {
    return new AiError("timeout", "OpenAI request timed out", { cause: error });
  }
  if (error instanceof APIUserAbortError) {
    return new AiError("timeout", "OpenAI request was aborted", { cause: error });
  }
  if (error instanceof APIConnectionError) {
    return new AiError("provider_error", "Could not reach OpenAI", { cause: error });
  }
  if (error instanceof APIError) {
    const status = error.status;
    if (status === 429) {
      return new AiError("rate_limited", "OpenAI rate limit exceeded", { cause: error });
    }
    if (status === 408 || status === 504) {
      return new AiError("timeout", `OpenAI timed out (HTTP ${status})`, { cause: error });
    }
    // 401/403 mean our server key is bad — a server problem, not the caller's.
    if (status === 400 || status === 413 || status === 422) {
      return new AiError("bad_request", `OpenAI rejected the request (HTTP ${status})`, {
        cause: error,
      });
    }
    return new AiError("provider_error", `OpenAI request failed (HTTP ${status ?? "unknown"})`, {
      cause: error,
    });
  }
  return new AiError("provider_error", "Unexpected error calling OpenAI", { cause: error });
}
