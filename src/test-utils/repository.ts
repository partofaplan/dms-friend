import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { DexieRepository, DmFriendDb, type CharacterInput } from "@/lib/db";

let dbCounter = 0;

/** A repository over a fresh in-memory IndexedDB, isolated per call. */
export function createTestRepository(): DexieRepository {
  const db = new DmFriendDb(`dm-friend-test-${++dbCounter}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  return new DexieRepository({ db });
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
