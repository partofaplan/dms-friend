import { render, screen, within } from "@testing-library/react";

import type { DexieRepository } from "@/lib/db";
import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw } from "@/test-utils/open5e-fixtures";
import {
  activateParty,
  characterInput,
  createParty,
  createTestRepository,
} from "@/test-utils/repository";

import { ChatScreen } from "./chat-screen";
import { ProfilesScreen } from "./profiles-screen";
import { RosterScreen } from "./roster-screen";
import { StableScreen } from "./stable-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/*
 * Each party-scoped screen invites the first entry when the active party has
 * nothing yet, even while another party has data.
 */

let repo: DexieRepository;

/** Zach with an empty, active "Waterdeep" and a "Strahd" that has a hero, a monster and chat. */
beforeEach(async () => {
  repo = createTestRepository();
  const zach = await repo.users.create("Zach");
  const strahd = await createParty(repo, zach.id, "Strahd");
  await strahd.scope.characters.create(characterInput({ name: "Ilsa" }));
  await strahd.scope.combatants.addFromMonster(normalizeMonster(goblinRaw)!);
  const waterdeep = await createParty(repo, zach.id, "Waterdeep");
  await activateParty(repo, waterdeep.partyProfile.id);
});

afterEach(() => {
  repo.db.close();
  vi.restoreAllMocks();
});

describe("empty states under an active party with no data", () => {
  it("roster invites scanning or adding a hero to this party", async () => {
    render(<RosterScreen repo={repo} />);

    expect(await screen.findByText("No characters yet.")).toBeInTheDocument();
    expect(screen.getByText(/No heroes in this party yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scan a character sheet" })).toHaveAttribute("href", "/scan");
    expect(screen.getByRole("button", { name: "Add character" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Ilsa" })).not.toBeInTheDocument();
  });

  it("stable invites finding monsters for this party", async () => {
    render(<StableScreen repo={repo} />);

    expect(await screen.findByText("No monsters in the stable.")).toBeInTheDocument();
    expect(screen.getByText(/this party's combat/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find monsters" })).toHaveAttribute("href", "/monsters");
  });

  it("chat prompts for a first question", async () => {
    render(<ChatScreen repo={repo} fetchImpl={vi.fn<typeof fetch>()} />);

    const log = await screen.findByRole("log", { name: "Conversation" });
    expect(within(log).getByText(/Ask for a ruling/)).toBeInTheDocument();
  });

  it("profiles invites creating a campaign when the active user has none", async () => {
    // Not normally reachable (a default party is recreated), but e.g. an odd import.
    vi.spyOn(repo.partyProfiles, "listByUser").mockResolvedValue([]);
    render(<ProfilesScreen repo={repo} />);

    expect(await screen.findByText("No campaigns yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Zach's parties" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create party" })).toBeInTheDocument();
    // There's always at least one user.
    expect(within(screen.getByRole("list", { name: "User profiles" })).getAllByRole("article")).toHaveLength(1);
  });
});
