import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  DEFAULT_PARTY_NAME,
  DEFAULT_USER_NAME,
  DexieRepository,
  DmFriendDb,
} from "./dexie-repository";
import {
  LastUserProfileError,
  RecordNotFoundError,
  ValidationError,
  type PartyScopedRepository,
} from "./repository";
import type { CharacterInput, PartyProfile, UserProfile } from "./schema";

/*
 * Each test gets its own in-memory IndexedDB (a fresh fake-indexeddb factory),
 * a deterministic clock, and sequential UUIDs, so no state leaks between tests.
 * Every test starts with one user ("Zach", id 1) owning one party profile
 * ("Table A", id 2); `party` is that party's scope.
 */

let repo: DexieRepository;
let tick: number;
let user: UserProfile;
let partyA: PartyProfile;
let party: PartyScopedRepository;

function makeId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

beforeEach(async () => {
  tick = 0;
  let idCounter = 0;
  const db = new DmFriendDb("dm-friend-test", {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  repo = new DexieRepository({
    db,
    now: () => at(tick++),
    generateId: () => makeId(++idCounter),
  });
  user = await repo.users.create("Zach");
  partyA = await repo.partyProfiles.create(user.id, "Table A");
  party = repo.forParty(partyA.id);
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
  it("creates a character with generated id, timestamps and the party scope", async () => {
    const created = await party.characters.create(character());
    expect(created.id).toBe(makeId(3));
    expect(created.partyProfileId).toBe(partyA.id);
    expect(created.createdAt).toBe(at(2));
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.conditions).toEqual([]);
    expect(created.hitPoints.temporary).toBe(0);

    expect(await party.characters.getById(created.id)).toEqual(created);
  });

  it("uses crypto.randomUUID by default", async () => {
    const defaultRepo = new DexieRepository({
      db: new DmFriendDb("uuid-test", {
        indexedDB: new IDBFactory(),
        IDBKeyRange,
      }),
    });
    const { partyProfile } = await defaultRepo.ensureDefaultProfile();
    const created = await defaultRepo
      .forParty(partyProfile.id)
      .characters.create(character());
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    defaultRepo.db.close();
  });

  it("returns undefined for an unknown id", async () => {
    expect(await party.characters.getById(makeId(999))).toBeUndefined();
  });

  it("lists the party's characters sorted by name", async () => {
    await party.characters.create(character({ name: "Zed" }));
    await party.characters.create(character({ name: "Aria" }));
    const all = await party.characters.getAll();
    expect(all.map((c) => c.name)).toEqual(["Aria", "Zed"]);
  });

  it("rejects invalid input without writing", async () => {
    await expect(
      party.characters.create(character({ level: 21 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(party.characters.create(character({ name: "" }))).rejects.toThrow(
      /Invalid character/,
    );
    expect(await party.characters.getAll()).toEqual([]);
  });

  it("refuses to create a character in a missing party profile", async () => {
    await expect(
      repo.forParty(makeId(999)).characters.create(character()),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await repo.db.characters.count()).toBe(0);
  });

  it("updates fields, bumps updatedAt, and preserves id/createdAt", async () => {
    const created = await party.characters.create(character());
    const updated = await party.characters.update(created.id, {
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
    expect(await party.characters.getById(created.id)).toEqual(updated);
  });

  it("ignores attempts to overwrite id, createdAt or the party via update", async () => {
    const other = await repo.partyProfiles.create(user.id, "Table B");
    const created = await party.characters.create(character());
    const updated = await party.characters.update(created.id, {
      id: makeId(500),
      createdAt: "1999-01-01T00:00:00.000Z",
      partyProfileId: other.id,
    } as never);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.partyProfileId).toBe(partyA.id);
    expect(await repo.forParty(other.id).characters.getAll()).toEqual([]);
  });

  it("rejects invalid updates and leaves the record unchanged", async () => {
    const created = await party.characters.create(character());
    await expect(
      party.characters.update(created.id, { armorClass: -2 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await party.characters.getById(created.id)).toEqual(created);
  });

  it("throws RecordNotFoundError when updating a missing character", async () => {
    await expect(
      party.characters.update(makeId(999), { level: 2 }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("deletes a character and removes it from parties", async () => {
    const a = await party.characters.create(character({ name: "A" }));
    const b = await party.characters.create(character({ name: "B" }));
    const legacy = await repo.parties.create({
      name: "Crew",
      characterIds: [a.id, b.id],
    });

    await party.characters.delete(a.id);

    expect(await party.characters.getById(a.id)).toBeUndefined();
    const after = await repo.parties.getById(legacy.id);
    expect(after?.characterIds).toEqual([b.id]);
    expect(after!.updatedAt > legacy.updatedAt).toBe(true);
  });
});

describe("characters are scoped to their party profile", () => {
  let partyB: PartyScopedRepository;

  beforeEach(async () => {
    partyB = repo.forParty(
      (await repo.partyProfiles.create(user.id, "Table B")).id,
    );
  });

  it("keeps each party's roster separate", async () => {
    const brakka = await party.characters.create(character({ name: "Brakka" }));
    const aria = await partyB.characters.create(character({ name: "Aria" }));

    expect(await party.characters.getAll()).toEqual([brakka]);
    expect(await partyB.characters.getAll()).toEqual([aria]);
    expect(await partyB.characters.getById(brakka.id)).toBeUndefined();
    expect(await party.characters.getById(aria.id)).toBeUndefined();
  });

  it("cannot update or delete another party's character", async () => {
    const brakka = await party.characters.create(character());

    await expect(
      partyB.characters.update(brakka.id, { level: 9 }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await partyB.characters.delete(brakka.id);

    expect(await party.characters.getById(brakka.id)).toEqual(brakka);
  });
});

describe("parties (legacy)", () => {
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
    const c = await party.characters.create(character());
    const legacy = await repo.parties.create({ name: "P", characterIds: [c.id] });
    await repo.parties.delete(legacy.id);
    expect(await party.characters.getById(c.id)).toEqual(c);
  });

  it("adds and removes characters and lists them in party order", async () => {
    const legacy = await repo.parties.create({ name: "Crew" });
    const zed = await party.characters.create(character({ name: "Zed" }));
    const aria = await party.characters.create(character({ name: "Aria" }));

    await repo.parties.addCharacter(legacy.id, zed.id);
    const withBoth = await repo.parties.addCharacter(legacy.id, aria.id);
    expect(withBoth.characterIds).toEqual([zed.id, aria.id]);
    expect(withBoth.updatedAt > legacy.updatedAt).toBe(true);

    // Adding again is a no-op.
    const again = await repo.parties.addCharacter(legacy.id, zed.id);
    expect(again).toEqual(withBoth);

    expect(await repo.parties.listCharacters(legacy.id)).toEqual([zed, aria]);

    const removed = await repo.parties.removeCharacter(legacy.id, zed.id);
    expect(removed.characterIds).toEqual([aria.id]);
    expect(await repo.parties.listCharacters(legacy.id)).toEqual([aria]);

    // Removing a non-member is a no-op.
    expect(await repo.parties.removeCharacter(legacy.id, zed.id)).toEqual(
      removed,
    );
    // The character itself still exists.
    expect(await party.characters.getById(zed.id)).toEqual(zed);
  });

  it("refuses to add a missing character or use a missing party", async () => {
    const legacy = await repo.parties.create({ name: "Crew" });
    const c = await party.characters.create(character());

    await expect(
      repo.parties.addCharacter(legacy.id, makeId(999)),
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
    expect((await repo.parties.getById(legacy.id))?.characterIds).toEqual([]);
  });

  it("creates a party with existing characters in the given order", async () => {
    const zed = await party.characters.create(character({ name: "Zed" }));
    const aria = await party.characters.create(character({ name: "Aria" }));
    const legacy = await repo.parties.create({
      name: "Crew",
      characterIds: [zed.id, aria.id],
    });
    expect(legacy.characterIds).toEqual([zed.id, aria.id]);
    expect(await repo.parties.listCharacters(legacy.id)).toEqual([zed, aria]);
  });

  it("refuses to create a party referencing a missing character", async () => {
    const c = await party.characters.create(character());
    const create = repo.parties.create({
      name: "Crew",
      characterIds: [c.id, makeId(999)],
    });
    await expect(create).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(create).rejects.toThrow(makeId(999));
    expect(await repo.parties.getAll()).toEqual([]);
  });

  it("refuses to update a party to reference a missing character", async () => {
    const c = await party.characters.create(character());
    const legacy = await repo.parties.create({
      name: "Crew",
      characterIds: [c.id],
    });
    await expect(
      repo.parties.update(legacy.id, { characterIds: [c.id, makeId(999)] }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await repo.parties.getById(legacy.id)).toEqual(legacy);
  });

  it("starts each test with an empty database", async () => {
    expect(await party.characters.getAll()).toEqual([]);
    expect(await repo.parties.getAll()).toEqual([]);
    expect(await repo.users.getAll()).toEqual([user]);
  });
});

describe("user profiles", () => {
  it("creates, lists by name, renames, and gets users", async () => {
    expect(user).toEqual({
      id: makeId(1),
      name: "Zach",
      createdAt: at(0),
      updatedAt: at(0),
    });
    const ada = await repo.users.create("  Ada ");
    expect(ada.name).toBe("Ada");
    expect((await repo.users.getAll()).map((u) => u.name)).toEqual([
      "Ada",
      "Zach",
    ]);

    const renamed = await repo.users.rename(ada.id, "Ada L.");
    expect(renamed).toMatchObject({ id: ada.id, name: "Ada L.", createdAt: ada.createdAt });
    expect(renamed.updatedAt > ada.updatedAt).toBe(true);
    expect(await repo.users.getById(ada.id)).toEqual(renamed);
    expect(await repo.users.getById(makeId(999))).toBeUndefined();
  });

  it("rejects blank names and renames of missing users", async () => {
    await expect(repo.users.create("   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.users.rename(user.id, "")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(repo.users.rename(makeId(999), "X")).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    expect(await repo.users.getAll()).toEqual([user]);
  });

  it("refuses to delete the last remaining user", async () => {
    await party.characters.create(character());
    const deleting = repo.users.delete(user.id);
    await expect(deleting).rejects.toBeInstanceOf(LastUserProfileError);
    await expect(deleting).rejects.toThrow(/last user profile/);
    expect(await repo.users.getAll()).toEqual([user]);
    expect(await party.characters.getAll()).toHaveLength(1);
  });

  it("treats deleting a missing user as a no-op", async () => {
    await expect(repo.users.delete(makeId(999))).resolves.toBeUndefined();
  });

  it("cascades a user delete to its parties and all their data", async () => {
    const other = await repo.users.create("Ada");
    const keep = repo.forParty(
      (await repo.partyProfiles.create(other.id, "Ada's table")).id,
    );
    const partyB = repo.forParty(
      (await repo.partyProfiles.create(user.id, "Table B")).id,
    );
    const goner = await party.characters.create(character({ name: "Goner" }));
    await partyB.characters.create(character({ name: "Also gone" }));
    await party.chat.append({ role: "user", content: "hi" });
    await partyB.chat.append({ role: "user", content: "hello" });
    const kept = await keep.characters.create(character({ name: "Kept" }));
    await keep.chat.append({ role: "user", content: "still here" });
    const legacy = await repo.parties.create({
      name: "Mixed",
      characterIds: [goner.id, kept.id],
    });

    await repo.users.delete(user.id);

    expect(await repo.users.getAll()).toEqual([other]);
    expect(await repo.partyProfiles.listByUser(user.id)).toEqual([]);
    expect(await repo.db.characters.toArray()).toEqual([kept]);
    expect(await repo.db.chatMessages.count()).toBe(1);
    expect(await keep.chat.list()).toHaveLength(1);
    // Legacy parties lose only the deleted characters.
    expect((await repo.parties.getById(legacy.id))?.characterIds).toEqual([kept.id]);
  });
});

describe("party profiles", () => {
  it("creates, lists by user (sorted by name), renames, and gets", async () => {
    expect(partyA).toEqual({
      id: makeId(2),
      userId: user.id,
      name: "Table A",
      createdAt: at(1),
      updatedAt: at(1),
    });
    const other = await repo.users.create("Ada");
    const theirs = await repo.partyProfiles.create(other.id, "Theirs");
    const aardvark = await repo.partyProfiles.create(user.id, " Aardvarks ");
    expect(aardvark.name).toBe("Aardvarks");

    expect(await repo.partyProfiles.listByUser(user.id)).toEqual([aardvark, partyA]);
    expect(await repo.partyProfiles.listByUser(other.id)).toEqual([theirs]);

    const renamed = await repo.partyProfiles.rename(partyA.id, "Strahd");
    expect(renamed).toMatchObject({ id: partyA.id, userId: user.id, name: "Strahd" });
    expect(renamed.updatedAt > partyA.updatedAt).toBe(true);
    expect(await repo.partyProfiles.getById(partyA.id)).toEqual(renamed);
  });

  it("validates names and the owning user", async () => {
    await expect(repo.partyProfiles.create(user.id, " ")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      repo.partyProfiles.create(makeId(999), "Orphan"),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(repo.partyProfiles.rename(partyA.id, "")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      repo.partyProfiles.rename(makeId(999), "X"),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await repo.partyProfiles.listByUser(user.id)).toEqual([partyA]);
  });

  it("cascades a party delete to its own data only", async () => {
    const partyB = repo.forParty(
      (await repo.partyProfiles.create(user.id, "Table B")).id,
    );
    await party.characters.create(character());
    await party.chat.append({ role: "user", content: "a" });
    const keptCharacter = await partyB.characters.create(character());
    const keptMessage = await partyB.chat.append({ role: "user", content: "b" });

    await repo.partyProfiles.delete(partyA.id);

    expect(await repo.partyProfiles.getById(partyA.id)).toBeUndefined();
    expect(await party.characters.getAll()).toEqual([]);
    expect(await party.chat.list()).toEqual([]);
    expect(await partyB.characters.getAll()).toEqual([keptCharacter]);
    expect(await partyB.chat.list()).toEqual([keptMessage]);
    // The user survives with no parties; deleting again is a no-op.
    expect(await repo.users.getById(user.id)).toEqual(user);
    await expect(repo.partyProfiles.delete(partyA.id)).resolves.toBeUndefined();
  });

  it("allows deleting a user's last party; writes to it then fail", async () => {
    await repo.partyProfiles.delete(partyA.id);
    expect(await repo.partyProfiles.listByUser(user.id)).toEqual([]);
    await expect(party.characters.create(character())).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
  });
});

describe("ensureDefaultProfile", () => {
  it("returns the oldest user's oldest party without creating anything", async () => {
    await repo.users.create("Newer");
    await repo.partyProfiles.create(user.id, "AAA newer table");
    expect(await repo.ensureDefaultProfile()).toEqual({ user, partyProfile: partyA });
    expect(await repo.users.getAll()).toHaveLength(2);
  });

  it("gives the default user a new party when its last one was deleted", async () => {
    await repo.partyProfiles.delete(partyA.id);
    const { user: same, partyProfile } = await repo.ensureDefaultProfile();
    expect(same).toEqual(user);
    expect(partyProfile).toMatchObject({ userId: user.id, name: DEFAULT_PARTY_NAME });
    expect(await repo.ensureDefaultProfile()).toEqual({ user, partyProfile });
  });

  it("seeds Default User and Default Party on an empty database, once", async () => {
    const fresh = new DexieRepository({
      db: new DmFriendDb("fresh", { indexedDB: new IDBFactory(), IDBKeyRange }),
    });
    const [first, second] = await Promise.all([
      fresh.ensureDefaultProfile(),
      fresh.ensureDefaultProfile(),
    ]);
    expect(first.user.name).toBe(DEFAULT_USER_NAME);
    expect(first.partyProfile).toMatchObject({
      name: DEFAULT_PARTY_NAME,
      userId: first.user.id,
    });
    expect(second).toEqual(first);
    expect(await fresh.db.userProfiles.count()).toBe(1);
    expect(await fresh.db.partyProfiles.count()).toBe(1);
    fresh.db.close();
  });
});

describe("unscoped (legacy) characters and combatants", () => {
  it("act on the default party profile", async () => {
    const legacy = await repo.characters.create(character({ name: "Legacy" }));
    expect(legacy.partyProfileId).toBe(partyA.id);
    expect(await party.characters.getAll()).toEqual([legacy]);
    expect(await repo.characters.getAll()).toEqual([legacy]);

    const partyB = repo.forParty(
      (await repo.partyProfiles.create(user.id, "Table B")).id,
    );
    const elsewhere = await partyB.characters.create(character());
    expect(await repo.characters.getById(elsewhere.id)).toBeUndefined();
    expect(await repo.combatants.getAll()).toEqual([]);
  });
});

describe("chat history", () => {
  it("appends turns in order and lists them", async () => {
    const question = await party.chat.append({ role: "user", content: "Can I grapple?" });
    const answer = await party.chat.append({
      role: "assistant",
      content: "Yes — make an Athletics check.",
    });
    expect(question).toEqual({
      id: makeId(3),
      partyProfileId: partyA.id,
      role: "user",
      content: "Can I grapple?",
      sequence: 0,
      createdAt: at(2),
    });
    expect(answer.sequence).toBe(1);
    expect(await party.chat.list()).toEqual([question, answer]);
  });

  it("orders by sequence even when timestamps tie", async () => {
    const frozen = new DexieRepository({
      db: repo.db,
      now: () => at(0),
    });
    const chat = frozen.forParty(partyA.id).chat;
    for (const content of ["one", "two", "three", "four"]) {
      await chat.append({ role: "user", content });
    }
    expect((await chat.list()).map((m) => m.content)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  it("gives concurrent appends distinct sequence numbers", async () => {
    await Promise.all(
      ["a", "b", "c"].map((content) => party.chat.append({ role: "user", content })),
    );
    expect((await party.chat.list()).map((m) => m.sequence)).toEqual([0, 1, 2]);
  });

  it("validates messages and the party profile", async () => {
    await expect(
      party.chat.append({ role: "user", content: "" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      party.chat.append({ role: "system", content: "x" } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.forParty(makeId(999)).chat.append({ role: "user", content: "x" }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await repo.db.chatMessages.count()).toBe(0);
  });

  it("keeps each party's history separate and clears one at a time", async () => {
    const partyB = repo.forParty(
      (await repo.partyProfiles.create(user.id, "Table B")).id,
    );
    await party.chat.append({ role: "user", content: "A1" });
    const b1 = await partyB.chat.append({ role: "user", content: "B1" });
    await party.chat.append({ role: "assistant", content: "A2" });
    expect(b1.sequence).toBe(0);
    expect((await party.chat.list()).map((m) => m.content)).toEqual(["A1", "A2"]);

    await party.chat.clear();

    expect(await party.chat.list()).toEqual([]);
    expect(await partyB.chat.list()).toEqual([b1]);
    // A cleared conversation starts over.
    expect((await party.chat.append({ role: "user", content: "new" })).sequence).toBe(0);
  });
});
