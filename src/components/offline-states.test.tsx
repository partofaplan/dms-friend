import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DexieRepository } from "@/lib/db";
import { normalizeMonster, normalizeMonsterSummary } from "@/lib/monsters/types";
import { goblinRaw } from "@/test-utils/open5e-fixtures";
import { characterInput, createTestRepository } from "@/test-utils/repository";

import { ChatScreen } from "./chat-screen";
import { MonsterSearch } from "./monster-search";
import { RosterScreen } from "./roster-screen";
import { ScanScreen } from "./scan-screen";

/*
 * How each screen behaves with the browser offline: the roster is local and
 * keeps working; monsters, chat, and scanning explain that they need a
 * connection instead of failing a request, and recover on reconnect.
 */

let repo: DexieRepository;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });
}

beforeEach(() => {
  repo = createTestRepository();
  fetchMock = vi.fn<typeof fetch>();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
});

afterEach(() => {
  repo.db.close();
  vi.restoreAllMocks();
});

describe("offline", () => {
  it("still loads the roster from local storage", async () => {
    await repo.characters.create(characterInput({ name: "Ilsa" }));
    render(<RosterScreen repo={repo} />);

    expect(await screen.findByRole("article", { name: "Ilsa" })).toBeInTheDocument();
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });

  it("parks a monster search until the connection returns, then runs it", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ results: [normalizeMonsterSummary(goblinRaw)!] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<MonsterSearch fetchImpl={fetchMock} />);

    expect(screen.getByText(/Monster lookup needs a connection/)).toBeInTheDocument();
    const input = screen.getByRole("searchbox", { name: "Search monsters" });
    expect(input).toHaveAccessibleDescription(/Monster lookup needs a connection/);

    fireEvent.change(input, { target: { value: "goblin" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Waiting for a connection to search for “goblin”.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    setOnline(true);
    expect(screen.queryByText(/Monster lookup needs a connection/)).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Goblin/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("monster lookup failing mid-request", () => {
    const goblinSummary = normalizeMonsterSummary(goblinRaw)!;
    const goblin = normalizeMonster(goblinRaw)!;

    function json(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    function isDetailRequest(input: Parameters<typeof fetch>[0]) {
      return new URL(String(input), "http://localhost").searchParams.has("slug");
    }

    function callsWhere(predicate: (input: Parameters<typeof fetch>[0]) => boolean) {
      return fetchMock.mock.calls.filter(([input]) => predicate(input)).length;
    }

    /** A fetch that stays pending until the test rejects it. */
    function stalledFetch() {
      let reject!: (reason: unknown) => void;
      const promise = new Promise<Response>((_, r) => (reject = r));
      return { promise, reject };
    }

    async function submitSearch(term: string) {
      fireEvent.change(screen.getByRole("searchbox", { name: "Search monsters" }), {
        target: { value: term },
      });
      await act(async () => {
        fireEvent.submit(screen.getByRole("search"));
      });
    }

    it("parks a search that fails after the connection drops, then retries it once on reconnect", async () => {
      setOnline(true);
      const stalled = stalledFetch();
      fetchMock
        .mockReturnValueOnce(stalled.promise)
        .mockResolvedValue(json({ results: [goblinSummary] }));
      render(<MonsterSearch fetchImpl={fetchMock} />);

      await submitSearch("goblin");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      setOnline(false);
      await act(async () => stalled.reject(new TypeError("Failed to fetch")));

      expect(screen.getAllByRole("status")[0]).toHaveTextContent(
        "Waiting for a connection to search for “goblin”.",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      setOnline(true);
      expect(await screen.findByRole("button", { name: /Goblin/ })).toBeInTheDocument();
      expect(screen.getAllByRole("status")[0]).toHaveTextContent("1 monster found.");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Nothing is parked any more, so a later online event doesn't refetch.
      setOnline(true);
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("parks a stat block that fails after the connection drops, then retries it once on reconnect", async () => {
      setOnline(true);
      const stalled = stalledFetch();
      let detailCalls = 0;
      fetchMock.mockImplementation(async (input) => {
        if (!isDetailRequest(input)) return json({ results: [goblinSummary] });
        detailCalls += 1;
        return detailCalls === 1 ? stalled.promise : json({ monster: goblin });
      });
      render(<MonsterSearch fetchImpl={fetchMock} />);

      await submitSearch("goblin");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Goblin/ }));
      });
      expect(callsWhere(isDetailRequest)).toBe(1);

      setOnline(false);
      await act(async () => stalled.reject(new TypeError("Failed to fetch")));

      expect(screen.getAllByRole("status")[1]).toHaveTextContent(
        "Waiting for a connection to load Goblin.",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Goblin" })).not.toBeInTheDocument();

      setOnline(true);
      expect(await screen.findByRole("article", { name: "Goblin" })).toBeInTheDocument();
      expect(screen.getAllByRole("status")[1]).toBeEmptyDOMElement();
      expect(callsWhere(isDetailRequest)).toBe(2);
      // The finished search isn't replayed either.
      expect(callsWhere((input) => !isDetailRequest(input))).toBe(1);

      setOnline(true);
      await act(async () => {});
      expect(callsWhere(isDetailRequest)).toBe(2);
    });

    it("still shows an error (with retry) when a request fails while online", async () => {
      setOnline(true);
      fetchMock.mockImplementation(async (input) => {
        if (!isDetailRequest(input)) return json({ results: [goblinSummary] });
        throw new TypeError("Failed to fetch");
      });
      render(<MonsterSearch fetchImpl={fetchMock} />);

      await submitSearch("goblin");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Goblin/ }));
      });

      expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't reach the server/);
      expect(screen.getByRole("button", { name: "Try Goblin again" })).toBeInTheDocument();
      expect(screen.getAllByRole("status")[1]).toBeEmptyDOMElement();

      // An error isn't parked, so an online event doesn't silently retry it.
      setOnline(true);
      await act(async () => {});
      expect(callsWhere(isDetailRequest)).toBe(1);
    });
  });

  it("disables sending a chat message with an explanation, and re-enables it online", async () => {
    render(<ChatScreen repo={repo} fetchImpl={fetchMock} />);
    await screen.findByText(/Using: no party/);

    // The message field is a combobox: it drives the @mention suggestions.
    const field = screen.getByRole("combobox", { name: "Ask the assistant" });
    fireEvent.change(field, { target: { value: "Can a goblin grapple?" } });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(/The assistant needs a connection/);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    // The draft survives so it can be sent later.
    expect(field).toHaveValue("Can a goblin grapple?");

    setOnline(true);
    expect(send).toBeEnabled();
    expect(screen.queryByText(/The assistant needs a connection/)).not.toBeInTheDocument();
  });

  it("disables sheet scanning but keeps manual entry available", async () => {
    render(<ScanScreen repo={repo} fetchImpl={fetchMock} />);

    const picker = await screen.findByLabelText("Character sheet photo");
    expect(picker).toBeDisabled();
    expect(picker).toHaveAccessibleDescription(/Reading a sheet needs a connection/);

    fireEvent.click(screen.getByRole("button", { name: "Enter manually instead" }));
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-enables the sheet picker when the connection returns", async () => {
    render(<ScanScreen repo={repo} fetchImpl={fetchMock} />);
    expect(await screen.findByLabelText("Character sheet photo")).toBeDisabled();

    setOnline(true);
    expect(screen.getByLabelText("Character sheet photo")).toBeEnabled();
    expect(screen.queryByText(/Reading a sheet needs a connection/)).not.toBeInTheDocument();
  });
});
