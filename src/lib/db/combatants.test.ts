import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";

import { DexieRepository, DmFriendDb } from "./dexie-repository";
import { RecordNotFoundError, ValidationError } from "./repository";
import { combatantName, type CombatantInput } from "./schema";

/*
 * The monster stable. Like the character tests, each test gets its own
 * in-memory IndexedDB, a deterministic clock, and sequential UUIDs.
 */

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

let factory: IDBFactory;
let repo: DexieRepository;
let tick: number;

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

beforeEach(() => {
  tick = 0;
  factory = new IDBFactory();
  repo = openRepo();
});

afterEach(() => {
  repo.db.close();
});

function combatant(overrides: Partial<CombatantInput> = {}): CombatantInput {
  return { monster: goblin, hitPoints: { max: 7, current: 7 }, ...overrides };
}

describe("combatants", () => {
  it("supports create, getById, getAll, update and delete", async () => {
    const created = await repo.combatants.create(combatant({ label: "Boss" }));
    expect(created).toMatchObject({
      id: makeId(1),
      label: "Boss",
      hitPoints: { max: 7, current: 7, temporary: 0 },
      conditions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await repo.combatants.getById(created.id)).toEqual(created);
    expect(await repo.combatants.getById(makeId(999))).toBeUndefined();

    const updated = await repo.combatants.update(created.id, {
      hitPoints: { max: 7, current: 3, temporary: 2 },
      conditions: ["prone"],
    });
    expect(updated.hitPoints).toEqual({ max: 7, current: 3, temporary: 2 });
    expect(updated.conditions).toEqual(["prone"]);
    expect(await repo.combatants.getAll()).toEqual([updated]);

    await repo.combatants.delete(created.id);
    expect(await repo.combatants.getAll()).toEqual([]);
    // Deleting a missing combatant is a no-op.
    await expect(repo.combatants.delete(created.id)).resolves.toBeUndefined();
  });

  it("bumps updatedAt and protects id/createdAt on update", async () => {
    const created = await repo.combatants.create(combatant());
    const updated = await repo.combatants.update(created.id, {
      notes: "Fled north",
      id: makeId(42),
      createdAt: "1999-01-01T00:00:00.000Z",
    } as never);

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.notes).toBe("Fled north");
    expect(await repo.combatants.getById(makeId(42))).toBeUndefined();
  });

  it("rejects invalid input and updates without writing", async () => {
    await expect(
      repo.combatants.create(combatant({ hitPoints: { max: 7, current: 9 } })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.combatants.getAll()).toEqual([]);

    const created = await repo.combatants.create(combatant());
    await expect(
      repo.combatants.update(created.id, {
        hitPoints: { max: 7, current: -1 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.combatants.getById(created.id)).toEqual(created);
  });

  it("throws RecordNotFoundError when updating a missing combatant", async () => {
    await expect(
      repo.combatants.update(makeId(999), { notes: "x" }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("lists combatants in the order they were added", async () => {
    await repo.combatants.create(combatant({ monster: guardian, hitPoints: { max: 178, current: 178 } }));
    await repo.combatants.create(combatant());
    expect((await repo.combatants.getAll()).map(combatantName)).toEqual([
      "Vault Guardian",
      "Goblin",
    ]);
  });
});

describe("combatants.addFromMonster", () => {
  it("starts at full HP from the stat block and captures the whole block", async () => {
    const added = await repo.combatants.addFromMonster(guardian);

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
    expect(await repo.combatants.getById(added.id)).toEqual(added);
  });

  it("adds the same monster twice as distinct, auto-numbered combatants", async () => {
    const first = await repo.combatants.addFromMonster(goblin);
    const second = await repo.combatants.addFromMonster(goblin);
    const third = await repo.combatants.addFromMonster(goblin);

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect([first, second, third].map(combatantName)).toEqual([
      "Goblin",
      "Goblin 2",
      "Goblin 3",
    ]);

    // A freed-up name is reused rather than skipped.
    await repo.combatants.delete(second.id);
    expect(combatantName(await repo.combatants.addFromMonster(goblin))).toBe(
      "Goblin 2",
    );

    // Each tracks its own HP.
    await repo.combatants.update(first.id, {
      hitPoints: { max: 7, current: 1 },
    });
    expect((await repo.combatants.getById(third.id))?.hitPoints.current).toBe(7);
  });

  it("honors an explicit label and max HP", async () => {
    const added = await repo.combatants.addFromMonster(goblin, {
      label: "Goblin boss",
      maxHp: 12,
    });
    expect(added.label).toBe("Goblin boss");
    expect(added.hitPoints).toEqual({ max: 12, current: 12, temporary: 0 });
  });

  it("rejects a stat block without hit points unless maxHp is given", async () => {
    const noHp = { ...goblin, hitPoints: null };
    await expect(repo.combatants.addFromMonster(noHp)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await repo.combatants.getAll()).toEqual([]);
    await expect(
      repo.combatants.addFromMonster(noHp, { maxHp: 5 }),
    ).resolves.toMatchObject({ hitPoints: { max: 5, current: 5 } });
  });
});

describe("schema migration to v2", () => {
  it("keeps v1 characters and parties and adds the combatants table", async () => {
    repo.db.close();

    // A database as the v1 app shipped it.
    const legacy = new Dexie("dm-friend-legacy", { indexedDB: factory, IDBKeyRange });
    legacy.version(1).stores({
      characters: "id, name, updatedAt",
      parties: "id, name, *characterIds, updatedAt",
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
    await legacy.table("characters").add(brakka);
    await legacy.table("parties").add({
      id: makeId(501),
      name: "Crew",
      characterIds: [brakka.id],
      createdAt: stamp,
      updatedAt: stamp,
    });
    legacy.close();

    repo = openRepo("dm-friend-legacy");
    expect(await repo.characters.getById(brakka.id)).toEqual(brakka);
    expect(
      (await repo.parties.listCharacters(makeId(501))).map((c) => c.name),
    ).toEqual(["Brakka"]);
    expect(await repo.combatants.getAll()).toEqual([]);

    await repo.combatants.addFromMonster(goblin);
    await repo.characters.update(brakka.id, {
      hitPoints: { max: 28, current: 28 },
    });
    expect(repo.db.verno).toBe(2);
    expect(await repo.combatants.getAll()).toHaveLength(1);
    expect((await repo.characters.getAll()).map((c) => c.name)).toEqual([
      "Brakka",
    ]);
  });
});
