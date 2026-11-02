import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DexieRepository } from "@/lib/db";
import { normalizeMonsterSummary } from "@/lib/monsters/types";
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

  it("disables sending a chat message with an explanation, and re-enables it online", async () => {
    render(<ChatScreen repo={repo} fetchImpl={fetchMock} />);
    await screen.findByText(/Using: no party/);

    const field = screen.getByRole("textbox", { name: "Ask the assistant" });
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

    const picker = screen.getByLabelText("Character sheet photo");
    expect(picker).toBeDisabled();
    expect(picker).toHaveAccessibleDescription(/Reading a sheet needs a connection/);

    fireEvent.click(screen.getByRole("button", { name: "Enter manually instead" }));
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-enables the sheet picker when the connection returns", () => {
    render(<ScanScreen repo={repo} fetchImpl={fetchMock} />);
    expect(screen.getByLabelText("Character sheet photo")).toBeDisabled();

    setOnline(true);
    expect(screen.getByLabelText("Character sheet photo")).toBeEnabled();
    expect(screen.queryByText(/Reading a sheet needs a connection/)).not.toBeInTheDocument();
  });
});
