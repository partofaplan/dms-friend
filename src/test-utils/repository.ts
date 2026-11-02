import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  DexieRepository,
  DmFriendDb,
  type AppRepository,
  type CharacterInput,
  type PartyProfile,
  type PartyScopedRepository,
  type UserProfile,
} from "@/lib/db";
import { setActiveParty } from "@/lib/profiles/active-profile";

let dbCounter = 0;

/** A repository over a fresh in-memory IndexedDB, isolated per call. */
export function createTestRepository(): DexieRepository {
  const db = new DmFriendDb(`dm-friend-test-${++dbCounter}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  return new DexieRepository({ db });
}

export interface SeededParty {
  user: UserProfile;
  partyProfile: PartyProfile;
  scope: PartyScopedRepository;
}

/** Makes the default user + party active (creating them) and returns its scope. */
export async function activateDefaultParty(repo: DexieRepository): Promise<SeededParty> {
  const { partyProfile } = await repo.ensureDefaultProfile();
  return activateParty(repo, partyProfile.id);
}

/** Makes an existing party profile (and its user) active. */
export async function activateParty(
  repo: DexieRepository,
  partyProfileId: string,
): Promise<SeededParty> {
  const { user, partyProfile } = await setActiveParty(partyProfileId, repo);
  return { user, partyProfile, scope: repo.forParty(partyProfile.id) };
}

/** Creates another party for `userId` without making it active. */
export async function createParty(
  repo: DexieRepository,
  userId: string,
  name: string,
): Promise<SeededParty> {
  const partyProfile = await repo.partyProfiles.create(userId, name);
  const user = (await repo.users.getById(userId))!;
  return { user, partyProfile, scope: repo.forParty(partyProfile.id) };
}

/** `base`, except that forParty() returns `scope` for its party (e.g. a wrapped scope). */
export function withPartyScope(base: DexieRepository, scope: PartyScopedRepository): AppRepository {
  const repo: AppRepository = Object.create(base);
  repo.forParty = (id) => (id === scope.partyProfileId ? scope : base.forParty(id));
  return repo;
}

export function characterInput(
  overrides: Partial<CharacterInput> = {},
): CharacterInput {
  return {
    name: "Brakka",
    className: "Fighter",
    level: 3,
    armorClass: 16,
    hitPoints: { max: 28, current: 28 },
    abilityScores: {
      strength: 16,
      dexterity: 12,
      constitution: 14,
      intelligence: 8,
      wisdom: 10,
      charisma: 10,
    },
    ...overrides,
  };
}
