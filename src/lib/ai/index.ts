import "server-only";
import { OpenAiProvider } from "./openai-provider";
import type { AiProvider } from "./provider";

/*
 * Server-only entry point. Reads secrets from the environment at call time,
 * so nothing here runs (or needs OPENAI_API_KEY) during `next build`.
 * Never import this module from client components.
 */

export { AiError, isAiError } from "./errors";
export type * from "./provider";

/** Returns the configured AI provider. Swap or compose providers here. */
export function getAiProvider(): AiProvider {
  return new OpenAiProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  });
}
