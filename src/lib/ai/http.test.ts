// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readJsonWithLimit, RequestBodyError } from "./http";

function streamRequest(
  chunks: Uint8Array[],
  onPull: () => void,
  { onCancel, headers }: { onCancel?: () => void; headers?: HeadersInit } = {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull();
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel: onCancel,
    },
    // Pull only on demand, so pull counts reflect what the reader consumed.
    { highWaterMark: 0 },
  );
  return new Request("http://localhost/", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RequestBodyError);
  return (error as RequestBodyError).reason;
}

describe("readJsonWithLimit", () => {
  it("parses a body within the limit", async () => {
    const request = new Request("http://localhost/", { method: "POST", body: '{"a":[1,2]}' });
    await expect(readJsonWithLimit(request, 11)).resolves.toEqual({ a: [1, 2] });
  });

  it("counts bytes, not characters", async () => {
    // "é" is two UTF-8 bytes, so this body is 5 bytes but 4 characters.
    const request = new Request("http://localhost/", { method: "POST", body: '"éé"' });
    expect(await reason(readJsonWithLimit(request, 5))).toBe("too_large");
  });

  it("rejects a declared Content-Length over the limit before reading", async () => {
    let pulls = 0;
    const request = streamRequest([new TextEncoder().encode("{}")], () => pulls++, {
      headers: { "content-length": "1000" },
    });
    expect(await reason(readJsonWithLimit(request, 999))).toBe("too_large");
    expect(pulls).toBe(0);
  });

  it("stops reading a chunked body as soon as the limit is crossed", async () => {
    const chunk = new Uint8Array(100).fill(0x20);
    let pulls = 0;
    let cancelled = false;
    const request = streamRequest(
      Array.from({ length: 50 }, () => chunk),
      () => pulls++,
      {
        onCancel: () => {
          cancelled = true;
        },
      },
    );

    expect(await reason(readJsonWithLimit(request, 250))).toBe("too_large");
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an empty body", ""],
  ])("reports invalid_json for %s", async (_label, body) => {
    const request = new Request("http://localhost/", { method: "POST", body });
    expect(await reason(readJsonWithLimit(request, 1024))).toBe("invalid_json");
  });

  it("reports invalid_json when there is no body", async () => {
    const request = new Request("http://localhost/", { method: "POST" });
    expect(await reason(readJsonWithLimit(request, 1024))).toBe("invalid_json");
  });
});
