import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { CombatantRepository, DexieRepository, PartyScopedRepository } from "@/lib/db";
import { normalizeMonster } from "@/lib/monsters/types";
import { setActiveParty } from "@/lib/profiles/active-profile";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";
import {
  activateDefaultParty,
  createParty,
  createTestRepository,
  withPartyScope,
} from "@/test-utils/repository";

import { StableScreen } from "./stable-screen";

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

let repo: DexieRepository;
/** The active party's scope; the stable shows only its combatants. */
let party: PartyScopedRepository;

beforeEach(async () => {
  repo = createTestRepository();
  ({ scope: party } = await activateDefaultParty(repo));
});

afterEach(() => {
  repo.db.close();
});

/** Two goblins (one hurt) and a guardian. */
async function seed() {
  const goblin1 = await party.combatants.addFromMonster(goblin);
  const hurt = await party.combatants.addFromMonster(goblin);
  const goblin2 = await party.combatants.update(hurt.id, {
    hitPoints: { max: 7, current: 4 },
  });
  const vault = await party.combatants.addFromMonster(guardian);
  return { goblin1, goblin2, vault };
}

function row(name: string) {
  return screen.getByRole("article", { name });
}

/**
 * Wraps the test repository so combatant updates wait until released, letting
 * tests interleave clicks while writes are in flight.
 */
function withDeferredUpdates(base: DexieRepository) {
  const gates: { id: string; open: () => void }[] = [];
  const combatants: CombatantRepository = Object.create(party.combatants);
  combatants.update = async (id, changes) => {
    await new Promise<void>((open) => gates.push({ id, open }));
    return party.combatants.update(id, changes);
  };
  return {
    repo: withPartyScope(base, { ...party, combatants }),
    waiting: () => gates.map((gate) => gate.id),
    release(id: string) {
      const index = gates.findIndex((gate) => gate.id === id);
      if (index === -1) throw new Error(`No pending update for ${id}`);
      gates.splice(index, 1)[0].open();
    },
  };
}

function rowControls(name: string) {
  return [
    screen.getByRole("button", { name: `Decrease HP for ${name}` }),
    screen.getByRole("button", { name: `Reset HP for ${name}` }),
    screen.getByRole("button", { name: `Set HP for ${name}` }),
    within(row(name)).getByRole("checkbox", { name: "Prone" }),
  ];
}

describe("StableScreen", () => {
  it("renders the empty state when the stable is empty", async () => {
    render(<StableScreen repo={repo} />);

    expect(await screen.findByText("No monsters in the stable.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find monsters" })).toHaveAttribute("href", "/monsters");
  });

  it("lists combatants with their label, AC, and live HP", async () => {
    await seed();
    render(<StableScreen repo={repo} />);

    const first = await screen.findByRole("article", { name: "Goblin" });
    expect(first).toHaveTextContent("Small humanoid · CR 1/4");
    expect(first).toHaveTextContent("AC15");
    expect(first).toHaveTextContent("HP7 / 7");
    expect(row("Goblin 2")).toHaveTextContent("Goblin · Small humanoid · CR 1/4");
    expect(row("Goblin 2")).toHaveTextContent("HP4 / 7");
    expect(row("Vault Guardian")).toHaveTextContent("HP178 / 178");
  });

  it("adjusts current HP within 0..max and persists it", async () => {
    const { goblin2 } = await seed();
    render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Goblin 2" });

    // Full-HP goblin can't go above max.
    expect(screen.getByRole("button", { name: "Increase HP for Goblin" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Increase HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP5 / 7"));

    // Setting a value clamps to the valid range.
    fireEvent.change(screen.getByLabelText("Current HP for Goblin 2"), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Set HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP0 / 7"));
    expect(screen.getByRole("button", { name: "Decrease HP for Goblin 2" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Current HP for Goblin 2"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Set HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP7 / 7"));
    expect((await party.combatants.getById(goblin2.id))?.hitPoints.current).toBe(7);
  });

  it("tracks temporary HP separately and reset restores full HP", async () => {
    const { goblin2 } = await seed();
    render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Goblin 2" });

    fireEvent.change(screen.getByLabelText("Temporary HP for Goblin 2"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Set temporary HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP4 / 7 (+5 temp)"));

    // HP nudges change current HP only, as on the roster.
    fireEvent.click(screen.getByRole("button", { name: "Decrease HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP3 / 7 (+5 temp)"));

    fireEvent.click(screen.getByRole("button", { name: "Reset HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP7 / 7"));
    expect(row("Goblin 2")).not.toHaveTextContent("temp");
    expect((await party.combatants.getById(goblin2.id))?.hitPoints).toEqual({
      max: 7,
      current: 7,
      temporary: 0,
    });
  });

  it("toggles conditions and persists them", async () => {
    const { vault } = await seed();
    render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Vault Guardian" });

    const conditions = within(row("Vault Guardian")).getByRole("group", {
      name: "Conditions for Vault Guardian",
    });
    fireEvent.click(within(conditions).getByRole("checkbox", { name: "Stunned" }));
    await waitFor(() => expect(row("Vault Guardian")).toHaveTextContent("Conditions: Stunned"));
    fireEvent.click(within(conditions).getByRole("checkbox", { name: "Prone" }));
    // Kept in the canonical CONDITIONS order.
    await waitFor(() =>
      expect(row("Vault Guardian")).toHaveTextContent("Conditions: Prone, Stunned"),
    );
    expect((await party.combatants.getById(vault.id))?.conditions).toEqual(["prone", "stunned"]);

    fireEvent.click(within(conditions).getByRole("checkbox", { name: "Stunned" }));
    await waitFor(() =>
      expect(within(conditions).getByRole("checkbox", { name: "Stunned" })).not.toBeChecked(),
    );
    expect((await party.combatants.getById(vault.id))?.conditions).toEqual(["prone"]);
  });

  it("renames a combatant and clears the label back to the monster name", async () => {
    const { vault } = await seed();
    render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Vault Guardian" });

    fireEvent.change(screen.getByLabelText("Label for Vault Guardian"), { target: { value: " Big one " } });
    fireEvent.click(screen.getByRole("button", { name: "Save label for Vault Guardian" }));
    expect(await screen.findByRole("article", { name: "Big one" })).toHaveTextContent("Vault Guardian");
    expect((await party.combatants.getById(vault.id))?.label).toBe("Big one");

    fireEvent.change(screen.getByLabelText("Label for Big one"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label for Big one" }));
    expect(await screen.findByRole("article", { name: "Vault Guardian" })).toBeInTheDocument();
    expect((await party.combatants.getById(vault.id))?.label).toBeUndefined();
  });

  it("removes a combatant only after confirmation", async () => {
    const { goblin2 } = await seed();
    render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Goblin 2" });

    fireEvent.click(screen.getByRole("button", { name: "Remove Goblin 2" }));
    const confirm = within(row("Goblin 2")).getByRole("button", { name: "Confirm remove" });
    expect(confirm).toHaveFocus();

    fireEvent.click(within(row("Goblin 2")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Remove Goblin 2" })).toHaveFocus();
    expect(await party.combatants.getById(goblin2.id)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Remove Goblin 2" }));
    fireEvent.click(within(row("Goblin 2")).getByRole("button", { name: "Confirm remove" }));

    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Goblin 2" })).not.toBeInTheDocument(),
    );
    expect(row("Goblin")).toBeInTheDocument();
    expect(await party.combatants.getById(goblin2.id)).toBeUndefined();
    expect(screen.getByRole("link", { name: "Find monsters" })).toHaveFocus();
  });

  it("does not lose HP clicks when writes for different combatants interleave", async () => {
    const { goblin1, goblin2 } = await seed();
    const deferred = withDeferredUpdates(repo);
    render(<StableScreen repo={deferred.repo} />);
    await screen.findByRole("article", { name: "Goblin 2" });

    fireEvent.click(screen.getByRole("button", { name: "Increase HP for Goblin 2" }));
    await waitFor(() => expect(deferred.waiting()).toEqual([goblin2.id]));
    for (const control of rowControls("Goblin 2")) expect(control).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease HP for Goblin" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Decrease HP for Goblin" }));
    await waitFor(() => expect(deferred.waiting()).toEqual([goblin2.id, goblin1.id]));

    // Goblin's write finishing must not re-enable Goblin 2's still-pending row.
    deferred.release(goblin1.id);
    await waitFor(() => expect(row("Goblin")).toHaveTextContent("HP6 / 7"));
    for (const control of rowControls("Goblin")) expect(control).toBeEnabled();
    for (const control of rowControls("Goblin 2")) expect(control).toBeDisabled();
    expect(row("Goblin 2")).toHaveTextContent("HP4 / 7");

    deferred.release(goblin2.id);
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP5 / 7"));
    for (const control of rowControls("Goblin 2")) expect(control).toBeEnabled();

    // A follow-up click builds on the stored value rather than a stale one.
    fireEvent.click(screen.getByRole("button", { name: "Increase HP for Goblin 2" }));
    await waitFor(() => expect(deferred.waiting()).toEqual([goblin2.id]));
    deferred.release(goblin2.id);
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP6 / 7"));

    expect((await party.combatants.getById(goblin2.id))?.hitPoints.current).toBe(6);
    expect((await party.combatants.getById(goblin1.id))?.hitPoints.current).toBe(6);
  });

  it("survives a remount (the stable is persisted)", async () => {
    await seed();
    const { unmount } = render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Goblin 2" });
    fireEvent.click(screen.getByRole("button", { name: "Decrease HP for Goblin 2" }));
    await waitFor(() => expect(row("Goblin 2")).toHaveTextContent("HP3 / 7"));
    unmount();

    render(<StableScreen repo={repo} />);
    expect(await screen.findByRole("article", { name: "Goblin 2" })).toHaveTextContent("HP3 / 7");
  });

  it("shows only the active party's stable, and re-scopes when the party switches", async () => {
    await seed();
    const { user } = await activateDefaultParty(repo);
    const other = await createParty(repo, user.id, "Curse of Strahd");
    // Numbering is per party: this is the other party's first goblin.
    await other.scope.combatants.addFromMonster(goblin);
    render(<StableScreen repo={repo} />);
    await screen.findByRole("article", { name: "Goblin 2" });
    expect(screen.getAllByRole("article")).toHaveLength(3);

    await act(() => setActiveParty(other.partyProfile.id, repo));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(row("Goblin")).toHaveTextContent("HP7 / 7");
    expect(screen.queryByRole("article", { name: "Vault Guardian" })).not.toBeInTheDocument();
  });
});
