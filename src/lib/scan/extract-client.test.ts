import { extractCharacter, SCAN_ERROR_MESSAGES } from "./extract-client";

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function respond(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

describe("extractCharacter", () => {
  it("returns the extracted data on success", async () => {
    const fetchImpl = respond({ data: { name: "Ilsa" }, raw: "{}" });
    await expect(extractCharacter(IMAGE, { fetchImpl })).resolves.toEqual({
      ok: true,
      data: { name: "Ilsa" },
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      imageDataUrl: IMAGE,
    });
  });

  it.each([
    ["missing_key", 500, /AI isn't configured/],
    ["rate_limited", 429, /AI is busy/],
    ["timeout", 504, /took too long/],
    ["payload_too_large", 413, /too large/],
    ["bad_request", 400, /couldn't be sent/],
    ["provider_error", 502, /couldn't read that sheet/],
    ["invalid_response", 502, /didn't make sense/],
  ] as const)("maps %s to a friendly message", async (kind, status, message) => {
    const fetchImpl = respond(
      { error: { kind, message: "raw provider detail" } },
      status,
    );
    const result = await extractCharacter(IMAGE, { fetchImpl });
    expect(result).toEqual({ ok: false, kind, message: SCAN_ERROR_MESSAGES[kind] });
    expect(SCAN_ERROR_MESSAGES[kind]).toMatch(message);
  });

  it.each([
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [504, "timeout"],
    [400, "bad_request"],
    [500, "provider_error"],
  ] as const)("falls back to the status (%i) without a usable body", async (status, kind) => {
    const result = await extractCharacter(IMAGE, { fetchImpl: respond("<html>", status) });
    expect(result).toMatchObject({ ok: false, kind });
  });

  it("reports a network failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(extractCharacter(IMAGE, { fetchImpl })).resolves.toMatchObject({
      ok: false,
      kind: "network",
    });
  });

  it("treats a 200 without an object payload as an invalid response", async () => {
    const result = await extractCharacter(IMAGE, { fetchImpl: respond({ data: [] }) });
    expect(result).toMatchObject({ ok: false, kind: "invalid_response" });
  });

  it("rethrows when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(
      extractCharacter(IMAGE, { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
