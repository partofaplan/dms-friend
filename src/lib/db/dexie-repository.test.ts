import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DexieRepository, DmFriendDb } from "./dexie-repository";
import { RecordNotFoundError, ValidationError } from "./repository";
import type { CharacterInput } from "./schema";

/*
 * Each test gets its own in-memory IndexedDB (a fresh fake-indexeddb factory),
 * a deterministic clock, and sequential UUIDs, so no state leaks between tests.
 */

let repo: DexieRepository;
let tick: number;

function makeId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

beforeEach(() => {
  tick = 0;
  let idCounter = 0;
  const db = new DmFriendDb("dm-friend-test", {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  repo = new DexieRepository({
    db,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    generateId: () => makeId(++idCounter),
  });
});

afterEach(async () => {
  repo.db.close();
});

function character(overrides: Partial<CharacterInput> = {}): CharacterInput {
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

describe("characters", () => {
  it("creates a character with generated id and timestamps", async () => {
    const created = await repo.characters.create(character());
    expect(created.id).toBe(makeId(1));
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.conditions).toEqual([]);
    expect(created.hitPoints.temporary).toBe(0);

    expect(await repo.characters.getById(created.id)).toEqual(created);
  });

  it("uses crypto.randomUUID by default", async () => {
    const defaultRepo = new DexieRepository({
      db: new DmFriendDb("uuid-test", {
        indexedDB: new IDBFactory(),
        IDBKeyRange,
      }),
    });
    const created = await defaultRepo.characters.create(character());
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    defaultRepo.db.close();
  });

  it("returns undefined for an unknown id", async () => {
    expect(await repo.characters.getById(makeId(999))).toBeUndefined();
  });

  it("lists all characters sorted by name", async () => {
    await repo.characters.create(character({ name: "Zed" }));
    await repo.characters.create(character({ name: "Aria" }));
    const all = await repo.characters.getAll();
    expect(all.map((c) => c.name)).toEqual(["Aria", "Zed"]);
  });

  it("rejects invalid input without writing", async () => {
    await expect(
      repo.characters.create(character({ level: 21 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.characters.create(character({ name: "" }))).rejects.toThrow(
      /Invalid character/,
    );
    expect(await repo.characters.getAll()).toEqual([]);
  });

  it("updates fields, bumps updatedAt, and preserves id/createdAt", async () => {
    const created = await repo.characters.create(character());
    const updated = await repo.characters.update(created.id, {
      level: 4,
      conditions: ["prone"],
      hitPoints: { max: 36, current: 20 },
    });

    expect(updated.level).toBe(4);
    expect(updated.conditions).toEqual(["prone"]);
    expect(updated.hitPoints).toEqual({ max: 36, current: 20, temporary: 0 });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(await repo.characters.getById(created.id)).toEqual(updated);
  });

  it("ignores attempts to overwrite id or createdAt via update", async () => {
    const created = await repo.characters.create(character());
    const updated = await repo.characters.update(created.id, {
      id: makeId(500),
      createdAt: "1999-01-01T00:00:00.000Z",
    } as never);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("rejects invalid updates and leaves the record unchanged", async () => {
    const created = await repo.characters.create(character());
    await expect(
      repo.characters.update(created.id, { armorClass: -2 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.characters.getById(created.id)).toEqual(created);
  });

  it("throws RecordNotFoundError when updating a missing character", async () => {
    await expect(
      repo.characters.update(makeId(999), { level: 2 }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("deletes a character and removes it from parties", async () => {
    const a = await repo.characters.create(character({ name: "A" }));
    const b = await repo.characters.create(character({ name: "B" }));
    const party = await repo.parties.create({
      name: "Crew",
      characterIds: [a.id, b.id],
    });

    await repo.characters.delete(a.id);

    expect(await repo.characters.getById(a.id)).toBeUndefined();
    const after = await repo.parties.getById(party.id);
    expect(after?.characterIds).toEqual([b.id]);
    expect(after!.updatedAt > party.updatedAt).toBe(true);
  });
});

describe("parties", () => {
  it("supports create, getById, getAll, update and delete", async () => {
    const p1 = await repo.parties.create({ name: "Wanderers" });
    const p2 = await repo.parties.create({ name: "Avengers" });
    expect(p1.characterIds).toEqual([]);
    expect(await repo.parties.getById(p1.id)).toEqual(p1);
    expect((await repo.parties.getAll()).map((p) => p.name)).toEqual([
      "Avengers",
      "Wanderers",
    ]);

    const renamed = await repo.parties.update(p1.id, { name: "Lost Souls" });
    expect(renamed.name).toBe("Lost Souls");
    expect(renamed.updatedAt > p1.updatedAt).toBe(true);

    await repo.parties.delete(p2.id);
    expect(await repo.parties.getById(p2.id)).toBeUndefined();
    expect(await repo.parties.getAll()).toEqual([renamed]);
  });

  it("rejects an invalid party", async () => {
    await expect(repo.parties.create({ name: "  " })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("deleting a party keeps its characters", async () => {
    const c = await repo.characters.create(character());
    const party = await repo.parties.create({ name: "P", characterIds: [c.id] });
    await repo.parties.delete(party.id);
    expect(await repo.characters.getById(c.id)).toEqual(c);
  });

  it("adds and removes characters and lists them in party order", async () => {
    const party = await repo.parties.create({ name: "Crew" });
    const zed = await repo.characters.create(character({ name: "Zed" }));
    const aria = await repo.characters.create(character({ name: "Aria" }));

    await repo.parties.addCharacter(party.id, zed.id);
    const withBoth = await repo.parties.addCharacter(party.id, aria.id);
    expect(withBoth.characterIds).toEqual([zed.id, aria.id]);
    expect(withBoth.updatedAt > party.updatedAt).toBe(true);

    // Adding again is a no-op.
    const again = await repo.parties.addCharacter(party.id, zed.id);
    expect(again).toEqual(withBoth);

    expect(await repo.parties.listCharacters(party.id)).toEqual([zed, aria]);

    const removed = await repo.parties.removeCharacter(party.id, zed.id);
    expect(removed.characterIds).toEqual([aria.id]);
    expect(await repo.parties.listCharacters(party.id)).toEqual([aria]);

    // Removing a non-member is a no-op.
    expect(await repo.parties.removeCharacter(party.id, zed.id)).toEqual(
      removed,
    );
    // The character itself still exists.
    expect(await repo.characters.getById(zed.id)).toEqual(zed);
  });

  it("refuses to add a missing character or use a missing party", async () => {
    const party = await repo.parties.create({ name: "Crew" });
    const c = await repo.characters.create(character());

    await expect(
      repo.parties.addCharacter(party.id, makeId(999)),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      repo.parties.addCharacter(makeId(998), c.id),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      repo.parties.removeCharacter(makeId(998), c.id),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      repo.parties.listCharacters(makeId(998)),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect((await repo.parties.getById(party.id))?.characterIds).toEqual([]);
  });

  it("starts each test with an empty database", async () => {
    expect(await repo.characters.getAll()).toEqual([]);
    expect(await repo.parties.getAll()).toEqual([]);
  });
});
