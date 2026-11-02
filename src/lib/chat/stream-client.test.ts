import { CHAT_STREAM_ENDPOINT, type ChatMessage } from "@/lib/ai/contracts";
import { aiErrorJson, controllableChatStream } from "@/test-utils/chat-stream";

import { CHAT_ERROR_MESSAGES, createSseParser, streamChat } from "./stream-client";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("createSseParser", () => {
  it("parses frames split across arbitrary chunks and CRLF line endings", () => {
    const parse = createSseParser();
    expect(parse('event: delta\r\ndata: {"type":"delta","de')).toEqual([]);
    expect(parse('lta":"a"}\r\n\r\nevent: done\ndata: {"type":"done"}\n\n')).toEqual([
      { type: "delta", delta: "a" },
      { type: "done" },
    ]);
  });

  it("treats a CRLF split between chunks as one line break", () => {
    const parse = createSseParser();
    expect(parse('event: delta\r')).toEqual([]);
    expect(parse('\ndata: {"type":"delta",\r')).toEqual([]);
    // Were each half normalized separately, this "\n" would end the frame early.
    expect(parse('\ndata: "delta":"a"}\r\n\r')).toEqual([]);
    expect(parse("\n")).toEqual([{ type: "delta", delta: "a" }]);
    expect(parse('event: done\r\ndata: {"type":"done"}\r\n\r\n')).toEqual([{ type: "done" }]);
  });

  it("ignores malformed frames and replaces server error text with a fixed message", () => {
    const parse = createSseParser();
    expect(
      parse(
        'data: not json\n\ndata: {"type":"weird"}\n\n' +
          'data: {"type":"error","error":{"kind":"rate_limited","message":"raw upstream"}}\n\n' +
          'data: {"type":"error","error":{"kind":"bogus"}}\n\n',
      ),
    ).toEqual([
      { type: "error", error: { kind: "rate_limited", message: CHAT_ERROR_MESSAGES.rate_limited } },
      { type: "error", error: { kind: "provider_error", message: CHAT_ERROR_MESSAGES.provider_error } },
    ]);
  });
});

describe("streamChat", () => {
  it("posts the messages and reports deltas until done", async () => {
    const stream = controllableChatStream();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
    const onDelta = vi.fn();

    const pending = streamChat(messages, { fetchImpl, onDelta });
    stream.delta("Roll ");
    stream.raw('event: delta\ndata: {"type":"delta",');
    stream.raw('"delta":"a d20."}\n\n');
    stream.done();

    expect(await pending).toEqual({ ok: true, text: "Roll a d20." });
    expect(onDelta.mock.calls).toEqual([["Roll "], ["a d20."]]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CHAT_STREAM_ENDPOINT);
    expect(JSON.parse(String(init?.body))).toEqual({ messages });
  });

  it("classifies a non-2xx JSON error by kind", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(aiErrorJson("missing_key", 500));
    expect(await streamChat(messages, { fetchImpl })).toEqual({
      ok: false,
      kind: "missing_key",
      message: CHAT_ERROR_MESSAGES.missing_key,
      interrupted: false,
      text: "",
    });
  });

  it("falls back to the status when the error body is unreadable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("oops", { status: 429 }));
    expect(await streamChat(messages, { fetchImpl })).toMatchObject({ ok: false, kind: "rate_limited" });
  });

  it("reports an error frame after partial text as interrupted", async () => {
    const stream = controllableChatStream();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
    const pending = streamChat(messages, { fetchImpl });
    stream.delta("Partial");
    stream.fail("timeout");
    expect(await pending).toEqual({
      ok: false,
      kind: "timeout",
      message: CHAT_ERROR_MESSAGES.timeout,
      interrupted: true,
      text: "Partial",
    });
  });

  it("treats a stream that closes without done as interrupted", async () => {
    const stream = controllableChatStream();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
    const pending = streamChat(messages, { fetchImpl });
    stream.delta("Half an ans");
    stream.close();
    expect(await pending).toMatchObject({ ok: false, kind: "network", interrupted: true, text: "Half an ans" });
  });

  it("reports a network failure, and rethrows when aborted", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await streamChat(messages, { fetchImpl })).toMatchObject({ ok: false, kind: "network" });

    const controller = new AbortController();
    controller.abort();
    await expect(streamChat(messages, { fetchImpl, signal: controller.signal })).rejects.toThrow();
  });
});
