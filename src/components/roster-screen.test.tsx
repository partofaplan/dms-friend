import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type { CharacterRepository, DexieRepository, PartyScopedRepository } from "@/lib/db";
import { setActiveParty } from "@/lib/profiles/active-profile";
import {
  activateDefaultParty,
  characterInput,
  createParty,
  createTestRepository,
  withPartyScope,
} from "@/test-utils/repository";

import { RosterScreen } from "./roster-screen";

let repo: DexieRepository;
/** The active party's scope; the roster shows only its characters. */
let party: PartyScopedRepository;

beforeEach(async () => {
  repo = createTestRepository();
  ({ scope: party } = await activateDefaultParty(repo));
});

afterEach(() => {
  repo.db.close();
});

async function seed() {
  const brakka = await party.characters.create(
    characterInput({ race: "Half-Orc", hitPoints: { max: 28, current: 20 } }),
  );
  const ilsa = await party.characters.create(
    characterInput({
      name: "Ilsa",
      className: "Wizard",
      level: 5,
      armorClass: 12,
      hitPoints: { max: 22, current: 22 },
    }),
  );
  return { brakka, ilsa };
}

function row(name: string) {
  return screen.getByRole("article", { name });
}

/**
 * Wraps the test repository so character updates wait until released, letting
 * tests interleave clicks while writes are in flight.
 */
function withDeferredUpdates(base: DexieRepository) {
  const gates: { id: string; open: () => void }[] = [];
  const characters: CharacterRepository = Object.create(party.characters);
  characters.update = async (id, changes) => {
    await new Promise<void>((open) => gates.push({ id, open }));
    return party.characters.update(id, changes);
  };
  return {
    repo: withPartyScope(base, { ...party, characters }),
    waiting: () => gates.map((gate) => gate.id),
    release(id: string) {
      const index = gates.findIndex((gate) => gate.id === id);
      if (index === -1) throw new Error(`No pending update for ${id}`);
      gates.splice(index, 1)[0].open();
    },
  };
}

function hpButtons(name: string) {
  return [
    screen.getByRole("button", { name: `Decrease HP for ${name}` }),
    screen.getByRole("button", { name: `Increase HP for ${name}` }),
    screen.getByRole("button", { name: `Edit ${name}` }),
  ];
}

describe("RosterScreen", () => {
  it("renders the empty state when there are no characters", async () => {
    render(<RosterScreen repo={repo} />);

    expect(await screen.findByText("No characters yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists characters with class, level, AC, and HP", async () => {
    await seed();
    render(<RosterScreen repo={repo} />);

    const brakka = await screen.findByRole("article", { name: "Brakka" });
    expect(brakka).toHaveTextContent("Half-Orc · Fighter 3");
    expect(brakka).toHaveTextContent("AC16");
    expect(brakka).toHaveTextContent("HP20 / 28");
    expect(row("Ilsa")).toHaveTextContent("Wizard 5");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("adds a character through the form and shows it in the list", async () => {
    render(<RosterScreen repo={repo} />);
    await screen.findByText("No characters yet.");

    fireEvent.click(screen.getByRole("button", { name: "Add character" }));
    for (const [label, value] of [
      ["Name", "Pip"],
      ["Class", "Rogue"],
      ["Armor Class", "14"],
      ["Max HP", "9"],
      ["Current HP", "9"],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(
      within(screen.getByRole("form")).getByRole("button", {
        name: "Add character",
      }),
    );

    expect(await screen.findByRole("article", { name: "Pip" })).toHaveTextContent(
      "Rogue 1",
    );
    expect(await party.characters.getAll()).toHaveLength(1);
  });

  it("edit populates the form and saves changes back to the list", async () => {
    await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Ilsa" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Ilsa" }));

    expect(
      screen.getByRole("heading", { name: "Edit Ilsa" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Ilsa");
    expect(screen.getByLabelText("Class")).toHaveValue("Wizard");
    expect(screen.getByLabelText("Level")).toHaveValue(5);
    expect(screen.getByLabelText("Current HP")).toHaveValue(22);

    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(row("Ilsa")).toHaveTextContent("Wizard 6"));
  });

  it("cancelling the form returns to the list without saving", async () => {
    await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Ilsa" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Ilsa" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(row("Ilsa")).toBeInTheDocument();
    expect((await party.characters.getAll()).map((c) => c.name)).toEqual([
      "Brakka",
      "Ilsa",
    ]);
  });

  it("deletes a character only after confirmation", async () => {
    const { brakka } = await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Brakka" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Brakka" }));
    const confirm = within(row("Brakka")).getByRole("button", {
      name: "Confirm delete",
    });
    expect(confirm).toHaveFocus();

    // Cancelling keeps the character and returns focus to its Delete button.
    fireEvent.click(within(row("Brakka")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete Brakka" })).toHaveFocus();
    expect(await party.characters.getById(brakka.id)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Delete Brakka" }));
    fireEvent.click(
      within(row("Brakka")).getByRole("button", { name: "Confirm delete" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Brakka" }),
      ).not.toBeInTheDocument(),
    );
    expect(row("Ilsa")).toBeInTheDocument();
    expect(await party.characters.getById(brakka.id)).toBeUndefined();
    // Focus moves off the removed row to a stable control.
    expect(screen.getByRole("button", { name: "Add character" })).toHaveFocus();
  });

  it("does not lose HP clicks when writes for different rows interleave", async () => {
    const { brakka, ilsa } = await seed();
    const deferred = withDeferredUpdates(repo);
    render(<RosterScreen repo={deferred.repo} />);
    await screen.findByRole("article", { name: "Brakka" });

    fireEvent.click(
      screen.getByRole("button", { name: "Increase HP for Brakka" }),
    );
    await waitFor(() => expect(deferred.waiting()).toEqual([brakka.id]));
    for (const button of hpButtons("Brakka")) expect(button).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Decrease HP for Ilsa" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Decrease HP for Ilsa" }));
    await waitFor(() =>
      expect(deferred.waiting()).toEqual([brakka.id, ilsa.id]),
    );

    // Ilsa's write finishing must not re-enable Brakka's still-pending row.
    deferred.release(ilsa.id);
    await waitFor(() => expect(row("Ilsa")).toHaveTextContent("HP21 / 22"));
    for (const button of hpButtons("Ilsa")) expect(button).toBeEnabled();
    for (const button of hpButtons("Brakka")) expect(button).toBeDisabled();
    expect(row("Brakka")).toHaveTextContent("HP20 / 28");

    deferred.release(brakka.id);
    await waitFor(() => expect(row("Brakka")).toHaveTextContent("HP21 / 28"));
    for (const button of hpButtons("Brakka")) expect(button).toBeEnabled();

    // A follow-up click builds on the stored value rather than a stale one.
    fireEvent.click(
      screen.getByRole("button", { name: "Increase HP for Brakka" }),
    );
    await waitFor(() => expect(deferred.waiting()).toEqual([brakka.id]));
    deferred.release(brakka.id);
    await waitFor(() => expect(row("Brakka")).toHaveTextContent("HP22 / 28"));

    expect((await party.characters.getById(brakka.id))?.hitPoints.current).toBe(
      22,
    );
    expect((await party.characters.getById(ilsa.id))?.hitPoints.current).toBe(
      21,
    );
  });

  it("blocks editing a character while its HP update is pending", async () => {
    await seed();
    const deferred = withDeferredUpdates(repo);
    render(<RosterScreen repo={deferred.repo} />);
    await screen.findByRole("article", { name: "Brakka" });

    fireEvent.click(
      screen.getByRole("button", { name: "Increase HP for Brakka" }),
    );
    await waitFor(() => expect(deferred.waiting()).toHaveLength(1));

    const edit = screen.getByRole("button", { name: "Edit Brakka" });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(
      screen.queryByRole("heading", { name: "Edit Brakka" }),
    ).not.toBeInTheDocument();

    deferred.release(deferred.waiting()[0]);
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    expect(screen.getByLabelText("Current HP")).toHaveValue(21);
  });

  it("adjusts current HP from the row and persists it", async () => {
    const { brakka } = await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Brakka" });

    fireEvent.click(
      screen.getByRole("button", { name: "Increase HP for Brakka" }),
    );
    await waitFor(() => expect(row("Brakka")).toHaveTextContent("HP21 / 28"));

    fireEvent.click(
      screen.getByRole("button", { name: "Decrease HP for Brakka" }),
    );
    await waitFor(() => expect(row("Brakka")).toHaveTextContent("HP20 / 28"));
    expect((await party.characters.getById(brakka.id))?.hitPoints.current).toBe(
      20,
    );
    // Ilsa is at full HP, so increasing is disabled.
    expect(
      screen.getByRole("button", { name: "Increase HP for Ilsa" }),
    ).toBeDisabled();
  });

  describe("party scoping", () => {
    it("adds a character to the active party only", async () => {
      const { user } = await activateDefaultParty(repo);
      const other = await createParty(repo, user.id, "Curse of Strahd");
      await other.scope.characters.create(characterInput({ name: "Ezmerelda" }));
      render(<RosterScreen repo={repo} />);
      await screen.findByText("No characters yet.");
      // Another party's characters never show up.
      expect(screen.queryByRole("article", { name: "Ezmerelda" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Add character" }));
      for (const [label, value] of [
        ["Name", "Pip"],
        ["Class", "Rogue"],
        ["Armor Class", "14"],
        ["Max HP", "9"],
        ["Current HP", "9"],
      ]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
      }
      fireEvent.click(
        within(screen.getByRole("form")).getByRole("button", { name: "Add character" }),
      );
      await screen.findByRole("article", { name: "Pip" });

      expect((await party.characters.getAll()).map((c) => c.name)).toEqual(["Pip"]);
      expect((await other.scope.characters.getAll()).map((c) => c.name)).toEqual(["Ezmerelda"]);
    });

    it("re-scopes to the new party when the active party switches", async () => {
      await seed();
      const { user } = await activateDefaultParty(repo);
      const other = await createParty(repo, user.id, "Curse of Strahd");
      await other.scope.characters.create(characterInput({ name: "Ezmerelda" }));
      render(<RosterScreen repo={repo} />);
      await screen.findByRole("article", { name: "Brakka" });

      await act(() => setActiveParty(other.partyProfile.id, repo));
      expect(await screen.findByRole("article", { name: "Ezmerelda" })).toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Brakka" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });
  });
});
