import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { getLastViewedMonster, setLastViewedMonster } from "@/lib/chat/last-monster";
import { normalizeMonster, normalizeMonsterSummary } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";

import { MonsterSearch, SEARCH_DEBOUNCE_MS } from "./monster-search";

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;
const summaries = [normalizeMonsterSummary(goblinRaw)!, normalizeMonsterSummary(guardianRaw)!];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestedUrl(call: number): URL {
  return new URL(String(fetchMock.mock.calls[call][0]), "http://localhost");
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderSearch() {
  return render(<MonsterSearch fetchImpl={fetchMock} />);
}

async function type(value: string) {
  fireEvent.change(screen.getByLabelText("Search monsters"), { target: { value } });
}

async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  });
}

function searchStatus() {
  // The first status region announces search progress; the second, detail loading.
  return screen.getAllByRole("status")[0];
}

describe("MonsterSearch", () => {
  it("labels the search input inside a search landmark", () => {
    renderSearch();
    const input = screen.getByRole("searchbox", { name: "Search monsters" });
    expect(screen.getByRole("search")).toContainElement(input);
    expect(input).toHaveAccessibleDescription(/SRD by monster name/);
  });

  it("debounces typing into a single search and lists results", async () => {
    fetchMock.mockResolvedValue(json({ results: summaries }));
    renderSearch();

    await type("g");
    await type("go");
    await type("gob");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl(0).pathname).toBe("/api/monsters");
    expect(requestedUrl(0).searchParams.get("search")).toBe("gob");

    const list = screen.getByRole("list");
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(within(list).getByRole("button", { name: /Goblin/ })).toHaveTextContent(
      "Small humanoid · CR 1/4",
    );
    expect(within(list).getByRole("button", { name: /Vault Guardian/ })).toHaveTextContent("CR 11");
    expect(searchStatus()).toHaveTextContent("2 monsters found.");
  });

  it("announces loading while the search is in flight", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSearch();

    await type("goblin");
    await flushDebounce();
    expect(searchStatus()).toHaveTextContent("Searching…");

    await act(async () => resolve(json({ results: summaries })));
    expect(searchStatus()).toHaveTextContent("2 monsters found.");
  });

  it("shows the empty state when nothing matches", async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    renderSearch();

    await type("zzzz");
    await flushDebounce();

    expect(searchStatus()).toHaveTextContent("No monsters found for “zzzz”.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a friendly error when the search fails", async () => {
    fetchMock.mockResolvedValue(
      json({ error: { kind: "upstream_error", message: "server text not shown" } }, 502),
    );
    renderSearch();

    await type("goblin");
    await flushDebounce();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The monster database is unavailable right now. Try again shortly.",
    );
    expect(screen.queryByText("server text not shown")).not.toBeInTheDocument();
  });

  it("shows a network error when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderSearch();

    await type("goblin");
    await flushDebounce();

    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't reach the server/);
  });

  it("clearing the input cancels the pending search and resets", async () => {
    fetchMock.mockResolvedValue(json({ results: summaries }));
    renderSearch();

    await type("gob");
    await type("");
    await flushDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(searchStatus()).toBeEmptyDOMElement();
  });

  it("submitting searches immediately", async () => {
    fetchMock.mockResolvedValue(json({ results: summaries }));
    renderSearch();

    await type("gob");
    await act(async () => {
      fireEvent.submit(screen.getByRole("search"));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selecting a goblin renders its stat block with only non-empty sections", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      return url.searchParams.has("slug") ? json({ monster: goblin }) : json({ results: summaries });
    });
    renderSearch();

    await type("gob");
    await flushDebounce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Goblin/ }));
    });

    expect(requestedUrl(1).searchParams.get("slug")).toBe("goblin");
    const block = screen.getByRole("article", { name: "Goblin" });
    const heading = within(block).getByRole("heading", { level: 2, name: "Goblin" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("button", { name: /Goblin/ })).toHaveAttribute("aria-current", "true");

    expect(within(block).getByText("Small humanoid (goblinoid), neutral evil")).toBeInTheDocument();
    expect(within(block).getByText("15 (leather armor, shield)")).toBeInTheDocument();
    expect(within(block).getByText("7 (2d6)")).toBeInTheDocument();
    expect(within(block).getByText("30 ft.")).toBeInTheDocument();
    expect(within(block).getByText("14 (+2)")).toBeInTheDocument();
    expect(within(block).getAllByText("8 (-1)")).toHaveLength(3);
    expect(within(block).getAllByText("10 (+0)")).toHaveLength(2);
    expect(within(block).getByText("Stealth +6")).toBeInTheDocument();
    expect(within(block).getByText("1/4")).toBeInTheDocument();

    const sections = within(block)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(sections).toEqual(["Ability Scores", "Traits", "Actions"]);
    expect(within(block).queryByText("Saving Throws")).not.toBeInTheDocument();
    expect(within(block).queryByText("Damage Immunities")).not.toBeInTheDocument();
    expect(within(block).getByText("Nimble Escape.")).toBeInTheDocument();
  });

  it("renders every section for a legendary monster", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      return url.searchParams.has("slug") ? json({ monster: guardian }) : json({ results: summaries });
    });
    renderSearch();

    await type("guard");
    await flushDebounce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Vault Guardian/ }));
    });

    const block = screen.getByRole("article", { name: "Vault Guardian" });
    const sections = within(block)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(sections).toEqual([
      "Ability Scores",
      "Traits",
      "Actions",
      "Bonus Actions",
      "Reactions",
      "Legendary Actions",
    ]);
    expect(within(block).getByText("23 (+6)")).toBeInTheDocument();
    expect(within(block).getByText("1 (-5)")).toBeInTheDocument();
    expect(within(block).getByText("STR +11, CON +10, WIS +5")).toBeInTheDocument();
    expect(within(block).getByText("40 ft., fly 60 ft. (hover)")).toBeInTheDocument();
    expect(within(block).getByText(/can take 3 legendary actions/)).toBeInTheDocument();
    expect(within(block).getByText("poison, psychic")).toBeInTheDocument();
  });

  it("shows a friendly error with retry when the stat block fails to load", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ results: summaries }))
      .mockResolvedValueOnce(json({ error: { kind: "timeout", message: "x" } }, 504))
      .mockResolvedValueOnce(json({ monster: goblin }));
    renderSearch();

    await type("gob");
    await flushDebounce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Goblin/ }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/took too long/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try Goblin again" }));
    });
    expect(screen.getByRole("article", { name: "Goblin" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("records the loaded stat block as the last-viewed monster for chat", async () => {
    setLastViewedMonster(null);
    fetchMock
      .mockResolvedValueOnce(json({ results: summaries }))
      .mockResolvedValueOnce(json({ error: { kind: "timeout", message: "x" } }, 504))
      .mockResolvedValueOnce(json({ monster: guardian }));
    renderSearch();

    await type("gob");
    await flushDebounce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Goblin/ }));
    });
    // A failed load does not change it.
    expect(getLastViewedMonster()).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Vault Guardian/ }));
    });
    expect(getLastViewedMonster()).toEqual(guardian);
    setLastViewedMonster(null);
  });
});
