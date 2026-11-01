// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_ERROR_PUBLIC_MESSAGE } from "@/lib/ai/errors";
import { POST as chatPOST } from "./chat/route";

/*
 * End-to-end through the real provider and OpenAI SDK: only the network
 * (global fetch) is mocked, so this covers SDK error → AiError → route response.
 */

const FAKE_KEY = "sk-abcdefghijklmnopqrstuvwxyz";
const MASKED_KEY = "sk-ab...wxyz";

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI 401 through /api/ai/chat", () => {
  it("returns the fixed public message and never the masked key", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: `Incorrect API key provided: ${MASKED_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        { status: 401, headers: { "x-request-id": "req_123" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await chatPOST(
      new Request("http://localhost/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const text = await response.text();

    expect(fetchMock).toHaveBeenCalled();
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: { kind: "provider_error", message: AI_ERROR_PUBLIC_MESSAGE.provider_error },
    });
    for (const leaked of [MASKED_KEY, FAKE_KEY, "Incorrect API key", "req_123"]) {
      expect(text).not.toContain(leaked);
    }
    // Server logs carry only our own message, not the upstream text either.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(MASKED_KEY);
  });
});
