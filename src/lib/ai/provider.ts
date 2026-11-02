import type { ChatMessage, ImageMimeType, TokenUsage } from "./contracts";

/*
 * Provider-agnostic AI interface. Route handlers depend only on this, so
 * OpenAI can be swapped for (or combined with) another provider later.
 * Implementations must throw AiError (see ./errors) on failure.
 */

export interface CallOptions {
  /** Aborts the upstream request (e.g. when the HTTP client disconnects). */
  signal?: AbortSignal;
}

export interface ChatRequest extends CallOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  reply: string;
  usage?: TokenUsage;
}

/** One incremental piece of a streamed assistant reply. */
export interface ChatStreamChunk {
  delta: string;
}

export interface ExtractCharacterRequest extends CallOptions {
  image: { base64: string; mimeType: ImageMimeType };
}

export interface ExtractCharacterResult {
  /** Parsed JSON shaped like the Character model; not yet schema-validated. */
  data: Record<string, unknown>;
  /** The model's raw text output, for debugging and re-parsing. */
  raw: string;
  usage?: TokenUsage;
}

export interface AiProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResult>;
  /**
   * Streaming variant of chat: yields non-empty text deltas in order. Setup
   * failures (e.g. missing key) surface as an AiError from the first next();
   * later failures as an AiError mid-iteration — including an upstream that
   * ends without signalling completion. Aborting `signal` (which also
   * interrupts a pending next()) or ending iteration early via return()
   * aborts the upstream request.
   */
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  extractCharacter(request: ExtractCharacterRequest): Promise<ExtractCharacterResult>;
}
