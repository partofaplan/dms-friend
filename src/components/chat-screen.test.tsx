import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { CHAT_STREAM_ENDPOINT, type ChatRequestBody } from "@/lib/ai/contracts";
import { buildSystemContext } from "@/lib/chat/context";
import { LAST_MONSTER_STORAGE_KEY, setLastViewedMonster } from "@/lib/chat/last-monster";
import { CHAT_ERROR_MESSAGES } from "@/lib/chat/stream-client";
import type { DexieRepository } from "@/lib/db";
import { normalizeMonster } from "@/lib/monsters/types";
import { aiErrorJson, controllableChatStream } from "@/test-utils/chat-stream";
import { goblinRaw } from "@/test-utils/open5e-fixtures";
import { characterInput, createTestRepository } from "@/test-utils/repository";

import { ChatScreen } from "./chat-screen";

// The real context builder, spied so a test can make it throw.
vi.mock("@/lib/chat/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/context")>();
  return { ...actual, buildSystemContext: vi.fn(actual.buildSystemContext) };
});

const goblin = normalizeMonster(goblinRaw)!;

let repo: DexieRepository;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  repo = createTestRepository();
  fetchMock = vi.fn<typeof fetch>();
});

afterEach(() => {
  // Unmount before resetting the shared store so the reset doesn't re-render.
  cleanup();
  repo.db.close();
  setLastViewedMonster(null);
  sessionStorage.clear();
  vi.mocked(buildSystemContext).mockReset();
});

async function seedParty() {
  await repo.characters.create(characterInput({ conditions: ["poisoned"] }));
  await repo.characters.create(
    characterInput({ name: "Ilsa", className: "Wizard", level: 5, armorClass: 12 }),
  );
}

async function renderChat() {
  render(<ChatScreen repo={repo} fetchImpl={fetchMock} />);
  await screen.findByText(/^Using:/);
}

const input = () => screen.getByLabelText("Ask the assistant");
const sendButton = () => screen.getByRole("button", { name: "Send" });
const log = () => screen.getByRole("log", { name: "Conversation" });

function ask(question: string) {
  fireEvent.change(input(), { target: { value: question } });
  fireEvent.click(sendButton());
}

/** The JSON body of the nth fetch call. */
function sentBody(call = 0): ChatRequestBody {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body)) as ChatRequestBody;
}

describe("ChatScreen", () => {
  it("notes the party and last-viewed monster it grounds answers in", async () => {
    await seedParty();
    setLastViewedMonster(goblin);
    await renderChat();
    expect(screen.getByText("Using: party (2) · Goblin")).toBeInTheDocument();
  });

  it("notes when there is no party or monster", async () => {
    await renderChat();
    expect(screen.getByText("Using: no party · no monster")).toBeInTheDocument();
  });

  it("follows a monster viewed while the chat is open", async () => {
    await renderChat();
    act(() => setLastViewedMonster(goblin));
    expect(screen.getByText("Using: no party · Goblin")).toBeInTheDocument();
  });

  it("streams the assistant reply delta by delta, grounded in the party and monster", async () => {
    await seedParty();
    setLastViewedMonster(goblin);
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    await renderChat();

    ask("Can the goblin grapple Ilsa?");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CHAT_STREAM_ENDPOINT);
    const { messages } = sentBody();
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Party (2):");
    expect(messages[0].content).toContain("- Ilsa — Wizard 5; AC 12");
    expect(messages[0].content).toContain("conditions: poisoned");
    expect(messages[0].content).toContain("Last-viewed monster: Goblin");
    expect(messages.at(-1)).toEqual({ role: "user", content: "Can the goblin grapple Ilsa?" });

    // Question shown, input cleared, send disabled, thinking indicator up.
    expect(within(log()).getByText("Can the goblin grapple Ilsa?")).toBeInTheDocument();
    expect(input()).toHaveValue("");
    fireEvent.change(input(), { target: { value: "follow-up" } });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("The assistant is answering…");

    stream.delta("Yes: contested ");
    expect(await within(log()).findByText("Yes: contested")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    stream.delta("Athletics check.");
    expect(await within(log()).findByText("Yes: contested Athletics check.")).toBeInTheDocument();

    stream.done();
    await waitFor(() => expect(log()).toHaveAttribute("aria-busy", "false"));
    expect(sendButton()).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("sends prior answered turns as history with the next question", async () => {
    const first = controllableChatStream();
    const second = controllableChatStream();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    await renderChat();

    ask("Q1");
    first.delta("A1");
    first.done();
    await waitFor(() => expect(log()).toHaveAttribute("aria-busy", "false"));

    ask("Q2");
    expect(sentBody(1).messages.slice(1)).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    fetchMock.mockResolvedValue(controllableChatStream().response);
    await renderChat();

    fireEvent.change(input(), { target: { value: "Hello" } });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a blank message", async () => {
    await renderChat();
    fireEvent.change(input(), { target: { value: "   " } });
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing_key", 500, /AI isn't configured/],
    ["rate_limited", 429, /busy/],
    ["timeout", 504, /too long/],
    ["provider_error", 502, /couldn't answer/],
  ] as const)("shows a friendly %s message and retries", async (kind, status, text) => {
    const stream = controllableChatStream();
    fetchMock.mockResolvedValueOnce(aiErrorJson(kind, status)).mockResolvedValueOnce(stream.response);
    await renderChat();

    ask("How far can I jump?");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).toHaveTextContent(CHAT_ERROR_MESSAGES[kind]);
    expect(alert).not.toHaveTextContent("server message");
    expect(alert).not.toHaveTextContent("interrupted");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1).messages.at(-1)).toEqual({ role: "user", content: "How far can I jump?" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    stream.delta("Your Strength score in feet.");
    stream.done();
    expect(await within(log()).findByText("Your Strength score in feet.")).toBeInTheDocument();
  });

  it("keeps a partial answer and says it was interrupted when the stream fails", async () => {
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    await renderChat();

    ask("Explain cover.");
    stream.delta("Half cover gives +2");
    await within(log()).findByText("Half cover gives +2");
    stream.fail("provider_error");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`The answer was interrupted. ${CHAT_ERROR_MESSAGES.provider_error}`);
    expect(within(log()).getByText("Half cover gives +2")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("still sends when an incomplete monster is in storage", async () => {
    sessionStorage.setItem(LAST_MONSTER_STORAGE_KEY, JSON.stringify({ name: "Goblin", actions: [] }));
    // Fresh app modules read storage the way a reloaded tab would.
    vi.resetModules();
    const { ChatScreen: FreshChatScreen } = await import("./chat-screen");
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    render(<FreshChatScreen repo={repo} fetchImpl={fetchMock} />);
    expect(await screen.findByText("Using: no party · no monster")).toBeInTheDocument();

    ask("Who acts first?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody().messages[0].content).toContain("Last-viewed monster: none.");
    stream.delta("Roll initiative.");
    stream.done();
    await waitFor(() => expect(log()).toHaveAttribute("aria-busy", "false"));
    fireEvent.change(input(), { target: { value: "Next?" } });
    expect(sendButton()).toBeEnabled();
  });

  it("answers without the monster when its context can't be built", async () => {
    setLastViewedMonster(goblin);
    vi.mocked(buildSystemContext).mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'map')");
    });
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    await renderChat();

    ask("Can it hide?");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(buildSystemContext).toHaveBeenLastCalledWith(expect.objectContaining({ lastMonster: null }));
    stream.delta("Yes, with Nimble Escape.");
    stream.done();
    await waitFor(() => expect(log()).toHaveAttribute("aria-busy", "false"));
    expect(within(log()).getByText("Yes, with Nimble Escape.")).toBeInTheDocument();
  });

  it("fails the turn, leaving Send and Retry usable, when no context can be built", async () => {
    const realBuild = vi.mocked(buildSystemContext).getMockImplementation()!;
    vi.mocked(buildSystemContext).mockImplementation(() => {
      throw new Error("boom");
    });
    await renderChat();

    ask("Anything?");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(CHAT_ERROR_MESSAGES.bad_request);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log()).toHaveAttribute("aria-busy", "false");
    fireEvent.change(input(), { target: { value: "Again" } });
    expect(sendButton()).toBeEnabled();

    // Once context builds again, Retry recovers the turn.
    vi.mocked(buildSystemContext).mockImplementation(realBuild);
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stream.delta("Recovered.");
    stream.done();
    expect(await within(log()).findByText("Recovered.")).toBeInTheDocument();
  });

  it("excludes failed turns from later history", async () => {
    const ok = controllableChatStream();
    fetchMock.mockResolvedValueOnce(aiErrorJson("timeout", 504)).mockResolvedValueOnce(ok.response);
    await renderChat();

    ask("Failed question");
    await screen.findByRole("alert");
    ask("Next question");
    expect(sentBody(1).messages.slice(1)).toEqual([{ role: "user", content: "Next question" }]);
  });

  it("clears the conversation and aborts a streaming answer", async () => {
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    await renderChat();
    const clear = screen.getByRole("button", { name: "Clear conversation" });
    expect(clear).toBeDisabled();

    ask("Something long");
    stream.delta("Starting…");
    await within(log()).findByText("Starting…");
    const signal = fetchMock.mock.calls[0][1]?.signal;

    fireEvent.click(clear);

    expect(signal?.aborted).toBe(true);
    expect(within(log()).queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask for a ruling/)).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-busy", "false");
    expect(clear).toBeDisabled();
    expect(input()).toHaveFocus();
  });

  it("renders the conversation as a list of messages", async () => {
    const stream = controllableChatStream();
    fetchMock.mockResolvedValue(stream.response);
    await renderChat();

    ask("Hi");
    stream.delta("Hello, DM.");
    stream.done();
    await waitFor(() => expect(log()).toHaveAttribute("aria-busy", "false"));

    const items = within(within(log()).getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("YouHi");
    expect(items[1]).toHaveTextContent("AssistantHello, DM.");
  });
});
