// @vitest-environment node
import { APIConnectionTimeoutError, APIError } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { describe, expect, it, vi } from "vitest";
import { ABILITIES, SKILLS } from "@/lib/db/schema";
import { characterExtractionJsonSchema } from "./character-extraction";
import { AiError } from "./errors";
import { DEFAULT_OPENAI_MODEL, OpenAiProvider, type OpenAiProviderOptions } from "./openai-provider";

const FAKE_KEY = "sk-test-not-a-real-key";

function completion(
  content: string | null,
  extra: { refusal?: string } = {},
): ChatCompletion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: DEFAULT_OPENAI_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content, refusal: extra.refusal ?? null },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  };
}

function setup(
  impl: () => Promise<ChatCompletion>,
  options: Partial<OpenAiProviderOptions> = {},
) {
  const create =
    vi.fn<(body: ChatCompletionCreateParamsNonStreaming, options?: unknown) => Promise<ChatCompletion>>(
      impl,
    );
  const createClient = vi.fn(() => ({ chat: { completions: { create } } }));
  const provider = new OpenAiProvider({ apiKey: FAKE_KEY, createClient, ...options });
  /** The request body sent on the most recent call. */
  const sentBody = () => {
    const body = create.mock.lastCall?.[0];
    if (!body) throw new Error("create was not called");
    return body;
  };
  return { provider, create, createClient, sentBody };
}

async function expectAiError(promise: Promise<unknown>, kind: AiError["kind"]) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AiError);
  expect((error as AiError).kind).toBe(kind);
}

const image = { base64: "aGVsbG8=", mimeType: "image/png" as const };

describe("OpenAiProvider.chat", () => {
  it("returns the assistant reply and usage", async () => {
    const { provider, create, createClient } = setup(async () => completion("Roll a d20."));

    const result = await provider.chat({
      messages: [{ role: "user", content: "What do I roll?" }],
      temperature: 0.5,
      maxTokens: 200,
    });

    expect(result).toEqual({ reply: "Roll a d20.", usage: { inputTokens: 12, outputTokens: 34 } });
    expect(createClient).toHaveBeenCalledWith({ apiKey: FAKE_KEY, timeoutMs: 60_000 });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
        messages: [{ role: "user", content: "What do I roll?" }],
        temperature: 0.5,
        max_completion_tokens: 200,
      }),
      expect.anything(),
    );
  });

  it("uses a configured model", async () => {
    const { provider, sentBody } = setup(async () => completion("ok"), { model: "gpt-4o-mini" });
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(sentBody().model).toBe("gpt-4o-mini");
  });

  it("reports missing_key without touching the network", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      const { provider, create, createClient } = setup(async () => completion("unused"), {
        apiKey,
      });
      await expectAiError(provider.chat({ messages: [{ role: "user", content: "hi" }] }), "missing_key");
      expect(createClient).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("reports invalid_response when there is no content", async () => {
    const { provider } = setup(async () => completion(null));
    await expectAiError(provider.chat({ messages: [{ role: "user", content: "hi" }] }), "invalid_response");
  });

  it.each([
    [429, "rate_limited"],
    [400, "bad_request"],
    [401, "provider_error"],
    [500, "provider_error"],
    [503, "provider_error"],
    [504, "timeout"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const { provider } = setup(async () => {
      throw APIError.generate(status, { message: "upstream detail" }, undefined, new Headers());
    });
    await expectAiError(provider.chat({ messages: [{ role: "user", content: "hi" }] }), kind);
  });

  it("maps an SDK timeout to timeout", async () => {
    const { provider } = setup(async () => {
      throw new APIConnectionTimeoutError();
    });
    await expectAiError(provider.chat({ messages: [{ role: "user", content: "hi" }] }), "timeout");
  });

  it("maps unknown failures to provider_error", async () => {
    const { provider } = setup(async () => {
      throw new TypeError("socket hang up");
    });
    await expectAiError(provider.chat({ messages: [{ role: "user", content: "hi" }] }), "provider_error");
  });
});

describe("OpenAiProvider.chatStream", () => {
  function chunk(
    content: string | undefined,
    finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
  ): ChatCompletionChunk {
    return {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: DEFAULT_OPENAI_MODEL,
      choices: [{ index: 0, delta: { content }, finish_reason: finishReason, logprobs: null }],
    };
  }

  /** An SDK stream of `contents`, then a finishing chunk unless it fails or is truncated. */
  async function* sdkStream(
    contents: (string | undefined)[],
    error?: unknown,
    { truncated = false } = {},
  ) {
    for (const content of contents) yield chunk(content);
    if (error) throw error;
    if (!truncated) yield chunk(undefined, "stop");
  }

  function streamSetup(stream: () => AsyncIterable<ChatCompletionChunk>, apiKey: string | undefined = FAKE_KEY) {
    const create = vi.fn<(body: ChatCompletionCreateParams, options?: unknown) => Promise<AsyncIterable<ChatCompletionChunk>>>(
      async () => stream(),
    );
    const createClient = vi.fn(() => ({ chat: { completions: { create } } }));
    const provider = new OpenAiProvider({ apiKey, createClient });
    return { provider, create, createClient };
  }

  async function collect(iterable: AsyncIterable<{ delta: string }>): Promise<string[]> {
    const out: string[] = [];
    for await (const { delta } of iterable) out.push(delta);
    return out;
  }

  it("requests a stream and yields the non-empty text deltas", async () => {
    const { provider, create } = streamSetup(() => sdkStream(["Roll ", undefined, "", "a d20."]));
    const signal = new AbortController().signal;

    const out = await collect(
      provider.chatStream({ messages: [{ role: "user", content: "hi" }], temperature: 0.2, signal }),
    );

    expect(out).toEqual(["Roll ", "a d20."]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o", stream: true, temperature: 0.2 }),
      { signal },
    );
  });

  it("reports missing_key on first iteration without touching the network", async () => {
    const { provider, createClient } = streamSetup(() => sdkStream(["x"]), "");
    await expectAiError(collect(provider.chatStream({ messages: [{ role: "user", content: "hi" }] })), "missing_key");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps a failure to start the stream", async () => {
    const { provider } = streamSetup(() => {
      throw APIError.generate(429, { message: "slow down" }, undefined, new Headers());
    });
    await expectAiError(collect(provider.chatStream({ messages: [{ role: "user", content: "hi" }] })), "rate_limited");
  });

  it("maps a mid-stream failure to an AiError", async () => {
    const { provider } = streamSetup(() => sdkStream(["partial"], new APIConnectionTimeoutError()));
    const seen: string[] = [];
    const error = await (async () => {
      for await (const { delta } of provider.chatStream({ messages: [{ role: "user", content: "hi" }] })) {
        seen.push(delta);
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["partial"]);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("timeout");
  });

  it("reports a stream that ends without a finish_reason as an error after its deltas", async () => {
    const { provider } = streamSetup(() => sdkStream(["partial"], undefined, { truncated: true }));
    const seen: string[] = [];
    const error = await (async () => {
      for await (const { delta } of provider.chatStream({ messages: [{ role: "user", content: "hi" }] })) {
        seen.push(delta);
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["partial"]);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("provider_error");
  });

  it("accepts a length-limited reply as complete", async () => {
    const { provider } = streamSetup(async function* () {
      yield chunk("cut by max tokens", "length");
    });
    expect(await collect(provider.chatStream({ messages: [{ role: "user", content: "hi" }] }))).toEqual([
      "cut by max tokens",
    ]);
  });
});

describe("OpenAiProvider.extractCharacter", () => {
  const extracted = {
    name: "Lia",
    race: "Half-Elf",
    className: "Bard",
    level: 3,
    armorClass: 14,
    hitPoints: { max: 21, current: 21, temporary: null },
    abilityScores: {
      strength: 8,
      dexterity: 14,
      constitution: 12,
      intelligence: 10,
      wisdom: 13,
      charisma: 17,
    },
    savingThrowProficiencies: ["dexterity", "charisma"],
    skillProficiencies: ["performance", "persuasion"],
    passivePerception: 11,
    conditions: [],
    notes: null,
  };

  it("sends the image with a strict JSON schema and returns parsed data plus raw text", async () => {
    const raw = JSON.stringify(extracted);
    const { provider, sentBody } = setup(async () => completion(raw));

    const result = await provider.extractCharacter({ image });

    expect(result).toEqual({ data: extracted, raw, usage: { inputTokens: 12, outputTokens: 34 } });
    const body = sentBody();
    expect(body.model).toBe("gpt-4o");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: expect.objectContaining({ strict: true, schema: characterExtractionJsonSchema }),
    });
    const user = body.messages.find((m) => m.role === "user");
    expect(user?.content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" },
    });
  });

  it("targets the character model's field names and enum values", () => {
    const { properties } = characterExtractionJsonSchema;
    expect(Object.keys(properties)).toEqual([
      "name",
      "race",
      "className",
      "level",
      "armorClass",
      "hitPoints",
      "abilityScores",
      "savingThrowProficiencies",
      "skillProficiencies",
      "passivePerception",
      "conditions",
      "notes",
    ]);
    expect(Object.keys(properties.abilityScores.properties)).toEqual([...ABILITIES]);
    expect(properties.skillProficiencies.items.enum).toEqual([...SKILLS]);
  });

  it("reports invalid_response for non-JSON output", async () => {
    const { provider } = setup(async () => completion("not json"));
    await expectAiError(provider.extractCharacter({ image }), "invalid_response");
  });

  it("reports invalid_response for a refusal", async () => {
    const { provider } = setup(async () => completion(null, { refusal: "I can't help with that." }));
    await expectAiError(provider.extractCharacter({ image }), "invalid_response");
  });

  it("reports missing_key without touching the network", async () => {
    const { provider, createClient } = setup(async () => completion("{}"), { apiKey: undefined });
    await expectAiError(provider.extractCharacter({ image }), "missing_key");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps a rate limit error", async () => {
    const { provider } = setup(async () => {
      throw APIError.generate(429, undefined, "slow down", new Headers());
    });
    await expectAiError(provider.extractCharacter({ image }), "rate_limited");
  });
});
