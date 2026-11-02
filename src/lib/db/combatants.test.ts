import Dexie, { type Table } from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";

import {
  DEFAULT_PARTY_NAME,
  DEFAULT_USER_NAME,
  DexieRepository,
  DmFriendDb,
} from "./dexie-repository";
import {
  RecordNotFoundError,
  ValidationError,
  type PartyScopedRepository,
} from "./repository";
import { combatantName, type CombatantInput } from "./schema";

/*
 * The monster stable. Like the character tests, each test gets its own
 * in-memory IndexedDB, a deterministic clock, and sequential UUIDs, plus one
 * user (id 1) with one party profile (id 2) whose scope is `stable`.
 */

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

let factory: IDBFactory;
let repo: DexieRepository;
let tick: number;
let partyProfileId: string;
let stable: PartyScopedRepository["combatants"];

function makeId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

function openRepo(name = "dm-friend-test"): DexieRepository {
  let idCounter = 0;
  const db = new DmFriendDb(name, { indexedDB: factory, IDBKeyRange });
  return new DexieRepository({
    db,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    generateId: () => makeId(++idCounter),
  });
}

beforeEach(async () => {
  tick = 0;
  factory = new IDBFactory();
  repo = openRepo();
  const user = await repo.users.create("Zach");
  partyProfileId = (await repo.partyProfiles.create(user.id, "Table A")).id;
  stable = repo.forParty(partyProfileId).combatants;
});

afterEach(() => {
  repo.db.close();
});

function combatant(overrides: Partial<CombatantInput> = {}): CombatantInput {
  return { monster: goblin, hitPoints: { max: 7, current: 7 }, ...overrides };
}

describe("combatants", () => {
  it("supports create, getById, getAll, update and delete", async () => {
    const created = await stable.create(combatant({ label: "Boss" }));
    expect(created).toMatchObject({
      id: makeId(3),
      partyProfileId,
      label: "Boss",
      hitPoints: { max: 7, current: 7, temporary: 0 },
      conditions: [],
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(await stable.getById(created.id)).toEqual(created);
    expect(await stable.getById(makeId(999))).toBeUndefined();

    const updated = await stable.update(created.id, {
      hitPoints: { max: 7, current: 3, temporary: 2 },
      conditions: ["prone"],
    });
    expect(updated.hitPoints).toEqual({ max: 7, current: 3, temporary: 2 });
    expect(updated.conditions).toEqual(["prone"]);
    expect(await stable.getAll()).toEqual([updated]);

    await stable.delete(created.id);
    expect(await stable.getAll()).toEqual([]);
    // Deleting a missing combatant is a no-op.
    await expect(stable.delete(created.id)).resolves.toBeUndefined();
  });

  it("bumps updatedAt and protects id/createdAt/party on update", async () => {
    const created = await stable.create(combatant());
    const updated = await stable.update(created.id, {
      notes: "Fled north",
      id: makeId(42),
      createdAt: "1999-01-01T00:00:00.000Z",
      partyProfileId: makeId(43),
    } as never);

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.partyProfileId).toBe(partyProfileId);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.notes).toBe("Fled north");
    expect(await stable.getById(makeId(42))).toBeUndefined();
  });

  it("rejects invalid input and updates without writing", async () => {
    await expect(
      stable.create(combatant({ hitPoints: { max: 7, current: 9 } })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await stable.getAll()).toEqual([]);

    const created = await stable.create(combatant());
    await expect(
      stable.update(created.id, {
        hitPoints: { max: 7, current: -1 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await stable.getById(created.id)).toEqual(created);
  });

  it("throws RecordNotFoundError when updating a missing combatant", async () => {
    await expect(
      stable.update(makeId(999), { notes: "x" }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("refuses to add to a missing party profile", async () => {
    const missing = repo.forParty(makeId(999)).combatants;
    await expect(missing.create(combatant())).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    await expect(missing.addFromMonster(goblin)).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    expect(await repo.db.combatants.count()).toBe(0);
  });

  it("lists combatants in the order they were added", async () => {
    await stable.create(combatant({ monster: guardian, hitPoints: { max: 178, current: 178 } }));
    await stable.create(combatant());
    expect((await stable.getAll()).map(combatantName)).toEqual([
      "Vault Guardian",
      "Goblin",
    ]);
  });
});

describe("combatants are scoped to their party profile", () => {
  let other: PartyScopedRepository["combatants"];

  beforeEach(async () => {
    const user = (await repo.users.getAll())[0];
    other = repo.forParty(
      (await repo.partyProfiles.create(user.id, "Table B")).id,
    ).combatants;
  });

  it("keeps each party's stable separate", async () => {
    const mine = await stable.create(combatant());
    const theirs = await other.create(combatant({ label: "Theirs" }));

    expect(await stable.getAll()).toEqual([mine]);
    expect(await other.getAll()).toEqual([theirs]);
    expect(await other.getById(mine.id)).toBeUndefined();
  });

  it("cannot update or delete another party's combatant", async () => {
    const mine = await stable.create(combatant());
    await expect(other.update(mine.id, { notes: "x" })).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    await other.delete(mine.id);
    expect(await stable.getById(mine.id)).toEqual(mine);
  });

  it("numbers duplicates per party", async () => {
    await stable.addFromMonster(goblin);
    await stable.addFromMonster(goblin);
    const first = await other.addFromMonster(goblin);
    const second = await other.addFromMonster(goblin);

    expect((await stable.getAll()).map(combatantName)).toEqual(["Goblin", "Goblin 2"]);
    expect([first, second].map(combatantName)).toEqual(["Goblin", "Goblin 2"]);
  });
});

describe("combatants.addFromMonster", () => {
  it("starts at full HP from the stat block and captures the whole block", async () => {
    const added = await stable.addFromMonster(guardian);

    expect(added.hitPoints).toEqual({ max: 178, current: 178, temporary: 0 });
    expect(added.conditions).toEqual([]);
    expect(added.label).toBeUndefined();
    expect(added.monster).toEqual(guardian);
    expect(added.monster).toMatchObject({
      slug: guardian.slug,
      name: guardian.name,
      armorClass: guardian.armorClass,
      challengeRating: "11",
    });
    expect(await stable.getById(added.id)).toEqual(added);
  });

  it("adds the same monster twice as distinct, auto-numbered combatants", async () => {
    const first = await stable.addFromMonster(goblin);
    const second = await stable.addFromMonster(goblin);
    const third = await stable.addFromMonster(goblin);

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect([first, second, third].map(combatantName)).toEqual([
      "Goblin",
      "Goblin 2",
      "Goblin 3",
    ]);

    // A freed-up name is reused rather than skipped.
    await stable.delete(second.id);
    expect(combatantName(await stable.addFromMonster(goblin))).toBe("Goblin 2");

    // Each tracks its own HP.
    await stable.update(first.id, {
      hitPoints: { max: 7, current: 1 },
    });
    expect((await stable.getById(third.id))?.hitPoints.current).toBe(7);
  });

  it("numbers concurrent adds without collisions", async () => {
    const added = await Promise.all([
      stable.addFromMonster(goblin),
      stable.addFromMonster(goblin),
      stable.addFromMonster(goblin),
    ]);
    expect(new Set(added.map(combatantName))).toEqual(
      new Set(["Goblin", "Goblin 2", "Goblin 3"]),
    );
  });

  it("honors an explicit label and max HP", async () => {
    const added = await stable.addFromMonster(goblin, {
      label: "Goblin boss",
      maxHp: 12,
    });
    expect(added.label).toBe("Goblin boss");
    expect(added.hitPoints).toEqual({ max: 12, current: 12, temporary: 0 });
  });

  it("rejects a stat block without hit points unless maxHp is given", async () => {
    const noHp = { ...goblin, hitPoints: null };
    await expect(stable.addFromMonster(noHp)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await stable.getAll()).toEqual([]);
    await expect(
      stable.addFromMonster(noHp, { maxHp: 5 }),
    ).resolves.toMatchObject({ hitPoints: { max: 5, current: 5 } });
  });
});

const stamp = "2025-06-01T00:00:00.000Z";
const brakka = {
  id: makeId(500),
  name: "Brakka",
  className: "Fighter",
  level: 3,
  armorClass: 16,
  hitPoints: { max: 28, current: 20, temporary: 0 },
  abilityScores: {
    strength: 16,
    dexterity: 12,
    constitution: 14,
    intelligence: 8,
    wisdom: 10,
    charisma: 10,
  },
  savingThrowProficiencies: [],
  skillProficiencies: [],
  conditions: [],
  createdAt: stamp,
  updatedAt: stamp,
};
const crew = {
  id: makeId(501),
  name: "Crew",
  characterIds: [brakka.id],
  createdAt: stamp,
  updatedAt: stamp,
};

/** Opens a database as an older app version shipped it, seeds it, and closes it. */
async function seedLegacy(
  name: string,
  version: 1 | 2,
  seed: (db: Dexie) => Promise<unknown>,
): Promise<void> {
  repo.db.close();
  const legacy = new Dexie(name, { indexedDB: factory, IDBKeyRange });
  legacy.version(1).stores({
    characters: "id, name, updatedAt",
    parties: "id, name, *characterIds, updatedAt",
  });
  if (version === 2) {
    legacy.version(2).stores({ combatants: "id, createdAt, monster.slug" });
  }
  await seed(legacy);
  legacy.close();
}

describe("schema migration from v1", () => {
  it("keeps v1 characters and parties, adopting them into the default party", async () => {
    await seedLegacy("dm-friend-legacy", 1, async (legacy) => {
      await legacy.table("characters").add(brakka);
      await legacy.table("parties").add(crew);
    });

    repo = openRepo("dm-friend-legacy");
    const [user] = await repo.users.getAll();
    const [partyProfile] = await repo.partyProfiles.listByUser(user.id);
    const scope = repo.forParty(partyProfile.id);

    expect(await scope.characters.getById(brakka.id)).toEqual({
      ...brakka,
      partyProfileId: partyProfile.id,
    });
    expect(
      (await repo.parties.listCharacters(crew.id)).map((c) => c.name),
    ).toEqual(["Brakka"]);
    expect(await scope.combatants.getAll()).toEqual([]);

    await scope.combatants.addFromMonster(goblin);
    await scope.characters.update(brakka.id, {
      hitPoints: { max: 28, current: 28 },
    });
    expect(repo.db.verno).toBe(3);
    expect(await scope.combatants.getAll()).toHaveLength(1);
    expect((await scope.characters.getAll()).map((c) => c.name)).toEqual([
      "Brakka",
    ]);
  });
});

describe("schema migration to v3", () => {
  const goblinEntry = {
    id: makeId(600),
    monster: goblin,
    hitPoints: { max: 7, current: 2, temporary: 0 },
    conditions: ["prone"],
    createdAt: stamp,
    updatedAt: stamp,
  };
  const bossEntry = {
    id: makeId(601),
    monster: goblin,
    label: "Goblin 2",
    hitPoints: { max: 7, current: 7, temporary: 0 },
    conditions: [],
    notes: "Boss",
    createdAt: "2025-06-01T00:00:01.000Z",
    updatedAt: "2025-06-01T00:00:01.000Z",
  };
  const aria = {
    ...brakka,
    id: makeId(502),
    name: "Aria",
    race: "Elf",
    className: "Wizard",
  };

  it("adopts every v2 character and combatant into a Default User → Default Party", async () => {
    await seedLegacy("dm-friend-v2", 2, async (legacy) => {
      await legacy.table("characters").bulkAdd([brakka, aria]);
      await legacy.table("parties").add(crew);
      await legacy.table("combatants").bulkAdd([goblinEntry, bossEntry]);
    });

    repo = openRepo("dm-friend-v2");
    expect(repo.db.verno).toBe(3);

    // Exactly one default user owning exactly one default party.
    const users = await repo.users.getAll();
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe(DEFAULT_USER_NAME);
    const parties = await repo.partyProfiles.listByUser(users[0].id);
    expect(parties).toHaveLength(1);
    const [partyProfile] = parties;
    expect(partyProfile).toMatchObject({
      name: DEFAULT_PARTY_NAME,
      userId: users[0].id,
    });
    expect(await repo.ensureDefaultProfile()).toEqual({
      user: users[0],
      partyProfile,
    });

    // Every record is stamped with the default party and otherwise unchanged.
    const scope = repo.forParty(partyProfile.id);
    const scoped = { partyProfileId: partyProfile.id };
    expect(await scope.characters.getAll()).toEqual([
      { ...aria, ...scoped },
      { ...brakka, ...scoped },
    ]);
    expect(await scope.combatants.getAll()).toEqual([
      { ...goblinEntry, ...scoped },
      { ...bossEntry, ...scoped },
    ]);
    expect(await repo.db.characters.count()).toBe(2);
    expect(await repo.db.combatants.count()).toBe(2);

    // Legacy party rows are carried over untouched.
    expect(await repo.parties.getAll()).toEqual([crew]);

    // The new tables work, and the stable keeps numbering from its old entries.
    expect(await scope.chat.list()).toEqual([]);
    await scope.chat.append({ role: "user", content: "Still here?" });
    expect(await scope.chat.list()).toHaveLength(1);
    expect(combatantName(await scope.combatants.addFromMonster(goblin))).toBe(
      "Goblin 3",
    );
    // The legacy unscoped view sees the migrated data too.
    expect(await repo.characters.getById(brakka.id)).toEqual({ ...brakka, ...scoped });
  });

  it("still creates the default profile for an empty v2 database", async () => {
    await seedLegacy("dm-friend-empty", 2, (legacy) => legacy.open());

    repo = openRepo("dm-friend-empty");
    const [user] = await repo.users.getAll();
    expect(user.name).toBe(DEFAULT_USER_NAME);
    expect(await repo.partyProfiles.listByUser(user.id)).toHaveLength(1);
    expect(await repo.db.characters.count()).toBe(0);
  });

  it("does not run the backfill again on reopen", async () => {
    await seedLegacy("dm-friend-reopen", 2, async (legacy) => {
      await legacy.table("characters").add(brakka);
    });
    repo = openRepo("dm-friend-reopen");
    const before = await repo.users.getAll();
    repo.db.close();

    repo = openRepo("dm-friend-reopen");
    expect(await repo.users.getAll()).toEqual(before);
    expect(await repo.db.partyProfiles.count()).toBe(1);
  });

  it("rolls a backfill that fails partway back to an intact v2 database", async () => {
    const name = "dm-friend-rollback";
    await seedLegacy(name, 2, async (legacy) => {
      await legacy.table("characters").bulkAdd([brakka, aria]);
      await legacy.table("parties").add(crew);
      await legacy.table("combatants").bulkAdd([goblinEntry, bossEntry]);
    });

    // Let the combatant backfill really stamp its rows, then throw — by then
    // the profiles exist and the characters are stamped inside the upgrade.
    const failing = new DmFriendDb(name, { indexedDB: factory, IDBKeyRange });
    const toCollection = failing.Table.prototype.toCollection;
    const seenMidUpgrade: { characters: unknown[]; combatants: unknown[]; users: number } = {
      characters: [],
      combatants: [],
      users: 0,
    };
    vi.spyOn(failing.Table.prototype, "toCollection").mockImplementation(
      function (this: Table) {
        const collection = toCollection.call(this);
        if (this.name !== "combatants") return collection;
        const modify = collection.modify.bind(collection);
        collection.modify = (async (changes: { partyProfileId: string }) => {
          await modify(changes);
          seenMidUpgrade.combatants = await toCollection.call(this).toArray();
          seenMidUpgrade.characters = await this.db.table("characters").toArray();
          seenMidUpgrade.users = await this.db.table("userProfiles").count();
          throw new Error("injected backfill failure");
        }) as unknown as typeof collection.modify;
        return collection;
      },
    );
    await expect(failing.open()).rejects.toThrow("injected backfill failure");
    failing.close();

    // The failure struck after real writes had landed in the upgrade transaction.
    expect(seenMidUpgrade.users).toBe(1);
    expect(seenMidUpgrade.characters).toHaveLength(2);
    expect(seenMidUpgrade.combatants).toHaveLength(2);
    for (const row of [...seenMidUpgrade.characters, ...seenMidUpgrade.combatants]) {
      expect(row).toHaveProperty("partyProfileId");
    }

    // Reopened as-is (no schema declared), the database is still exactly v2.
    const raw = new Dexie(name, { indexedDB: factory, IDBKeyRange });
    await raw.open();
    expect(raw.verno).toBe(2);
    expect(raw.tables.map((t) => t.name).sort()).toEqual([
      "characters",
      "combatants",
      "parties",
    ]);
    expect(await raw.table("characters").toArray()).toEqual([brakka, aria]);
    expect(await raw.table("combatants").toArray()).toEqual([
      goblinEntry,
      bossEntry,
    ]);
    expect(await raw.table("parties").toArray()).toEqual([crew]);
    raw.close();

    // A clean open afterwards migrates normally.
    repo = openRepo(name);
    expect(repo.db.verno).toBe(3);
    const users = await repo.users.getAll();
    expect(users.map((u) => u.name)).toEqual([DEFAULT_USER_NAME]);
    const [partyProfile] = await repo.partyProfiles.listByUser(users[0].id);
    expect(partyProfile.name).toBe(DEFAULT_PARTY_NAME);
    expect(await repo.db.partyProfiles.count()).toBe(1);
    const scope = repo.forParty(partyProfile.id);
    const scoped = { partyProfileId: partyProfile.id };
    expect(await scope.characters.getAll()).toEqual([
      { ...aria, ...scoped },
      { ...brakka, ...scoped },
    ]);
    expect(await scope.combatants.getAll()).toEqual([
      { ...goblinEntry, ...scoped },
      { ...bossEntry, ...scoped },
    ]);
    expect(await repo.parties.getAll()).toEqual([crew]);
  });
});
