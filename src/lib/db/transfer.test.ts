import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { normalizeMonster } from "@/lib/monsters/types";
import { characterInput } from "@/test-utils/repository";
import { goblinRaw } from "@/test-utils/open5e-fixtures";

import { DexieRepository, DmFriendDb } from "./dexie-repository";
import { RecordNotFoundError } from "./repository";
import type { UserProfile } from "./schema";
import {
  ImportError,
  USER_PROFILE_EXPORT_FORMAT_VERSION,
  parseUserProfileExport,
  type UserProfileExport,
} from "./transfer";

const goblin = normalizeMonster(goblinRaw)!;

let repo: DexieRepository;
let tick: number;
let user: UserProfile;

function makeId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

beforeEach(async () => {
  tick = 0;
  let idCounter = 0;
  repo = new DexieRepository({
    db: new DmFriendDb("dm-friend-test", { indexedDB: new IDBFactory(), IDBKeyRange }),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    generateId: () => makeId(++idCounter),
  });
  user = await repo.users.create("Zach");
});

afterEach(() => {
  repo.db.close();
});

/** A user with two parties, each with characters, a stable and a chat. */
async function seedTwoParties() {
  const strahd = await repo.partyProfiles.create(user.id, "Strahd");
  const phandelver = await repo.partyProfiles.create(user.id, "Phandelver");
  for (const [profile, hero] of [
    [strahd, "Ireena"],
    [phandelver, "Sildar"],
  ] as const) {
    const scope = repo.forParty(profile.id);
    await scope.characters.create(characterInput({ name: hero }));
    await scope.characters.create(characterInput({ name: `${hero}'s friend` }));
    await scope.combatants.addFromMonster(goblin);
    await scope.combatants.addFromMonster(goblin);
    await scope.chat.append({ role: "user", content: `Where is ${hero}?` });
    await scope.chat.append({ role: "assistant", content: "Nearby." });
  }
  return { strahd, phandelver };
}

/** Everything about a record except its identity, for comparing copies. */
function content<T extends { id: string; partyProfileId: string }>(records: T[]) {
  return records.map((record) => {
    const rest: Partial<T> = { ...record };
    delete rest.id;
    delete rest.partyProfileId;
    return rest;
  });
}

describe("exportUserProfile", () => {
  it("captures the user, its parties, and all of their data", async () => {
    const { strahd, phandelver } = await seedTwoParties();
    const other = await repo.users.create("Not exported");
    const elsewhere = await repo.partyProfiles.create(other.id, "Elsewhere");
    await repo.forParty(elsewhere.id).characters.create(characterInput());

    const data = await repo.exportUserProfile(user.id);

    expect(data.formatVersion).toBe(USER_PROFILE_EXPORT_FORMAT_VERSION);
    expect(data.user).toEqual(user);
    expect(data.partyProfiles).toEqual([strahd, phandelver]);
    expect(data.characters).toHaveLength(4);
    expect(data.combatants).toHaveLength(4);
    expect(data.chatMessages).toHaveLength(4);
    expect(data.chatMessages.map((m) => [m.partyProfileId, m.sequence])).toEqual([
      [strahd.id, 0],
      [strahd.id, 1],
      [phandelver.id, 0],
      [phandelver.id, 1],
    ]);
    // It survives a JSON round trip as a valid export.
    expect(parseUserProfileExport(JSON.stringify(data))).toEqual(data);
  });

  it("throws RecordNotFoundError for a missing user", async () => {
    await expect(repo.exportUserProfile(makeId(999))).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
  });
});

describe("importUserProfile", () => {
  it("re-creates the export as a new, fully isolated user", async () => {
    const { strahd, phandelver } = await seedTwoParties();
    const exported = await repo.exportUserProfile(user.id);
    const before = {
      users: await repo.db.userProfiles.toArray(),
      parties: await repo.db.partyProfiles.toArray(),
      characters: await repo.db.characters.toArray(),
      combatants: await repo.db.combatants.toArray(),
      chat: await repo.db.chatMessages.toArray(),
    };

    const imported = await repo.importUserProfile(JSON.stringify(exported));

    expect(imported.name).toBe(user.name);
    expect(imported.id).not.toBe(user.id);
    expect(await repo.users.getAll()).toHaveLength(2);

    // Fresh ids throughout: nothing in the copy reuses an original id.
    const originalIds = new Set(
      Object.values(before).flatMap((rows) => rows.map((row) => row.id)),
    );
    const copies = await repo.partyProfiles.listByUser(imported.id);
    expect(copies.map((p) => p.name)).toEqual(["Phandelver", "Strahd"]);
    for (const original of [strahd, phandelver]) {
      const copy = copies.find((p) => p.name === original.name)!;
      expect(originalIds.has(copy.id)).toBe(false);
      const [from, to] = [repo.forParty(original.id), repo.forParty(copy.id)];

      // Each party's data came along under the matching copied party.
      const copied = {
        characters: await to.characters.getAll(),
        combatants: await to.combatants.getAll(),
        chat: await to.chat.list(),
      };
      expect(content(copied.characters)).toEqual(content(await from.characters.getAll()));
      expect(content(copied.combatants)).toEqual(content(await from.combatants.getAll()));
      expect(content(copied.chat)).toEqual(content(await from.chat.list()));
      for (const record of Object.values(copied).flat()) {
        expect(originalIds.has(record.id)).toBe(false);
        expect(record.partyProfileId).toBe(copy.id);
      }
    }

    // The original is untouched by the import…
    expect(await repo.db.userProfiles.get(user.id)).toEqual(user);
    for (const [key, rows] of [
      ["partyProfiles", before.parties],
      ["characters", before.characters],
      ["combatants", before.combatants],
      ["chatMessages", before.chat],
    ] as const) {
      expect(await repo.db.table(key).bulkGet(rows.map((r) => r.id))).toEqual(rows);
    }

    // …and editing or deleting the copy doesn't reach it either.
    const copy = repo.forParty(copies[0].id);
    const [copiedCharacter] = await copy.characters.getAll();
    await copy.characters.update(copiedCharacter.id, { level: 20 });
    await copy.chat.clear();
    await repo.users.delete(imported.id);
    expect(await repo.db.characters.toArray()).toEqual(before.characters);
    expect(await repo.db.chatMessages.toArray()).toEqual(before.chat);
    expect(await repo.db.partyProfiles.toArray()).toEqual(before.parties);
  });

  it("can import the same export twice without collisions", async () => {
    await seedTwoParties();
    const exported = await repo.exportUserProfile(user.id);
    const first = await repo.importUserProfile(exported);
    const second = await repo.importUserProfile(exported);
    expect(new Set([user.id, first.id, second.id]).size).toBe(3);
    expect(await repo.db.characters.count()).toBe(12);
    // Chat in the copy continues from the imported sequence.
    const [party] = await repo.partyProfiles.listByUser(second.id);
    expect(
      (await repo.forParty(party.id).chat.append({ role: "user", content: "next" }))
        .sequence,
    ).toBe(2);
  });

  describe("rejects invalid data with ImportError and writes nothing", () => {
    let valid: UserProfileExport;

    beforeEach(async () => {
      await seedTwoParties();
      valid = await repo.exportUserProfile(user.id);
    });

    it.each<[string, () => unknown]>([
      ["malformed JSON", () => "{not json"],
      ["a non-object", () => 42],
      ["null", () => null],
      ["an unsupported format version", () => ({ ...valid, formatVersion: 2 })],
      ["a missing format version", () => ({ ...valid, formatVersion: undefined })],
      ["a missing user", () => ({ ...valid, user: undefined })],
      [
        "an invalid character",
        () => ({
          ...valid,
          characters: [{ ...valid.characters[0], level: 99 }],
        }),
      ],
      [
        "a party owned by someone else",
        () => ({
          ...valid,
          partyProfiles: [{ ...valid.partyProfiles[0], userId: makeId(999) }],
        }),
      ],
      [
        "a record pointing at a party outside the export",
        () => ({
          ...valid,
          combatants: [{ ...valid.combatants[0], partyProfileId: makeId(999) }],
        }),
      ],
      [
        "duplicate party ids",
        () => ({
          ...valid,
          partyProfiles: [valid.partyProfiles[0], valid.partyProfiles[0]],
        }),
      ],
    ])("%s", async (_label, make) => {
      const counts = async () =>
        Promise.all(
          ["userProfiles", "partyProfiles", "characters", "combatants", "chatMessages"].map(
            (t) => repo.db.table(t).count(),
          ),
        );
      const before = await counts();
      await expect(repo.importUserProfile(make())).rejects.toBeInstanceOf(ImportError);
      expect(await counts()).toEqual(before);
    });

    it("reports the version problem and the schema issues", async () => {
      await expect(
        repo.importUserProfile({ ...valid, formatVersion: 2 }),
      ).rejects.toThrow(/format version: 2/);
      const error = await repo
        .importUserProfile({ ...valid, characters: [{ ...valid.characters[0], level: 99 }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).issues[0].path).toEqual(["characters", 0, "level"]);
    });
  });
});
