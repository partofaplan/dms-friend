import Dexie, { type DexieOptions, type EntityTable, type Table } from "dexie";
import type { z } from "zod";
import {
  LastUserProfileError,
  RecordNotFoundError,
  ValidationError,
  type AddMonsterOptions,
  type AppRepository,
  type CharacterRepository,
  type CombatantRepository,
  type DefaultProfile,
  type PartyProfileRepository,
  type PartyRepository,
  type PartyScopedRepository,
  type UserProfileRepository,
} from "./repository";
import type { MonsterStatBlock } from "@/lib/monsters/types";

import {
  characterInputSchema,
  characterSchema,
  chatMessageInputSchema,
  chatMessageRecordSchema,
  combatantInputSchema,
  combatantName,
  combatantSchema,
  partyInputSchema,
  partyProfileInputSchema,
  partyProfileSchema,
  partySchema,
  userProfileInputSchema,
  userProfileSchema,
  type Character,
  type CharacterInput,
  type CharacterUpdate,
  type ChatMessageInput,
  type ChatMessageRecord,
  type Combatant,
  type CombatantInput,
  type CombatantUpdate,
  type Party,
  type PartyInput,
  type PartyProfile,
  type PartyUpdate,
  type UserProfile,
} from "./schema";
import {
  parseUserProfileExport,
  remapUserProfileExport,
  USER_PROFILE_EXPORT_FORMAT_VERSION,
  type UserProfileExport,
} from "./transfer";

export const DEFAULT_DB_NAME = "dm-friend";
export const DEFAULT_USER_NAME = "Default User";
export const DEFAULT_PARTY_NAME = "Default Party";

export class DmFriendDb extends Dexie {
  characters!: EntityTable<Character, "id">;
  parties!: EntityTable<Party, "id">;

  combatants!: EntityTable<Combatant, "id">;

  userProfiles!: EntityTable<UserProfile, "id">;
  partyProfiles!: EntityTable<PartyProfile, "id">;
  chatMessages!: EntityTable<ChatMessageRecord, "id">;

  constructor(name: string = DEFAULT_DB_NAME, options?: DexieOptions) {
    super(name, options);
    // Never edit a shipped version: add a new one. Dexie carries earlier
    // tables forward, so v2 only declares what it adds and existing
    // characters/parties are untouched by the upgrade.
    this.version(1).stores({
      characters: "id, name, updatedAt",
      // Multi-entry index lets us find every party containing a character.
      parties: "id, name, *characterIds, updatedAt",
    });
    // v2: the monster stable.
    this.version(2).stores({
      combatants: "id, createdAt, monster.slug",
    });
    // v3: user and party profiles. Characters, combatants and chat now belong
    // to a party profile (re-declared with the new index). Existing data is
    // adopted by a "Default User" → "Default Party"; the legacy parties table
    // is carried forward untouched.
    this.version(3)
      .stores({
        characters: "id, name, updatedAt, partyProfileId",
        combatants: "id, createdAt, monster.slug, partyProfileId",
        userProfiles: "id, name, createdAt",
        partyProfiles: "id, userId, name, createdAt",
        // The compound index lists a party's conversation in order.
        chatMessages: "id, partyProfileId, [partyProfileId+sequence]",
      })
      .upgrade(async (tx) => {
        const stamp = new Date().toISOString();
        const userId = crypto.randomUUID();
        const partyProfileId = crypto.randomUUID();
        await tx.table("userProfiles").add({
          id: userId,
          name: DEFAULT_USER_NAME,
          createdAt: stamp,
          updatedAt: stamp,
        });
        await tx.table("partyProfiles").add({
          id: partyProfileId,
          userId,
          name: DEFAULT_PARTY_NAME,
          createdAt: stamp,
          updatedAt: stamp,
        });
        // Only the scope key is added; every other field (updatedAt included)
        // is left exactly as it was.
        await tx.table("characters").toCollection().modify({ partyProfileId });
        await tx.table("combatants").toCollection().modify({ partyProfileId });
      });
  }
}

export interface DexieRepositoryOptions {
  /** Database to use; defaults to a new DmFriendDb with the default name. */
  db?: DmFriendDb;
  /** Clock returning an ISO timestamp; injectable for deterministic tests. */
  now?: () => string;
  /** UUID generator; injectable for deterministic tests. */
  generateId?: () => string;
}

function validate<S extends z.ZodType>(
  schema: S,
  entity: string,
  data: unknown,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(entity, result.error);
  return result.data;
}

/**
 * Order added: createdAt, then id so records stamped in the same millisecond
 * still come back in one deterministic order.
 */
function byCreation(a: Combatant, b: Combatant): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A party's chat messages, in conversation order. */
function chatRange(db: DmFriendDb, partyProfileId: string) {
  return db.chatMessages
    .where("[partyProfileId+sequence]")
    .between([partyProfileId, Dexie.minKey], [partyProfileId, Dexie.maxKey]);
}

export class DexieRepository implements AppRepository {
  readonly db: DmFriendDb;
  readonly users: UserProfileRepository;
  readonly partyProfiles: PartyProfileRepository;
  /** @deprecated Acts on the default party profile; use forParty(). */
  readonly characters: CharacterRepository;
  readonly parties: PartyRepository;
  /** @deprecated Acts on the default party profile; use forParty(). */
  readonly combatants: CombatantRepository;

  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(options: DexieRepositoryOptions = {}) {
    this.db = options.db ?? new DmFriendDb();
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());

    this.users = {
      create: (name) => this.createUser(name),
      getById: (id) => this.db.userProfiles.get(id),
      getAll: () => this.db.userProfiles.orderBy("name").toArray(),
      rename: (id, name) => this.renameUser(id, name),
      delete: (id) => this.deleteUser(id),
    };

    this.partyProfiles = {
      create: (userId, name) => this.createPartyProfile(userId, name),
      getById: (id) => this.db.partyProfiles.get(id),
      listByUser: (userId) =>
        this.db.partyProfiles.where("userId").equals(userId).sortBy("name"),
      rename: (id, name) => this.renamePartyProfile(id, name),
      delete: (id) => this.deletePartyProfile(id),
    };

    // Back-compat for screens that predate profiles: each call resolves the
    // default party profile and delegates to its scope.
    const inDefault = <T>(fn: (scope: PartyScopedRepository) => Promise<T>) =>
      this.ensureDefaultProfile().then(({ partyProfile }) =>
        fn(this.forParty(partyProfile.id)),
      );
    this.characters = {
      create: (input) => inDefault((s) => s.characters.create(input)),
      getById: (id) => inDefault((s) => s.characters.getById(id)),
      getAll: () => inDefault((s) => s.characters.getAll()),
      update: (id, changes) =>
        inDefault((s) => s.characters.update(id, changes)),
      delete: (id) => inDefault((s) => s.characters.delete(id)),
    };
    this.combatants = {
      create: (input) => inDefault((s) => s.combatants.create(input)),
      addFromMonster: (monster, options) =>
        inDefault((s) => s.combatants.addFromMonster(monster, options)),
      getById: (id) => inDefault((s) => s.combatants.getById(id)),
      getAll: () => inDefault((s) => s.combatants.getAll()),
      update: (id, changes) =>
        inDefault((s) => s.combatants.update(id, changes)),
      delete: (id) => inDefault((s) => s.combatants.delete(id)),
    };

    this.parties = {
      create: (input) => this.createParty(input),
      getById: (id) => this.db.parties.get(id),
      getAll: () => this.db.parties.orderBy("name").toArray(),
      update: (id, changes) => this.updateParty(id, changes),
      delete: (id) => this.db.parties.delete(id),
      addCharacter: (partyId, characterId) =>
        this.addCharacterToParty(partyId, characterId),
      removeCharacter: (partyId, characterId) =>
        this.removeCharacterFromParty(partyId, characterId),
      listCharacters: (partyId) => this.listPartyCharacters(partyId),
    };
  }

  /** One scope object per party, so callers (and test spies) can hold onto it. */
  private readonly scopes = new Map<string, PartyScopedRepository>();

  forParty(partyProfileId: string): PartyScopedRepository {
    let scope = this.scopes.get(partyProfileId);
    if (!scope) {
      scope = this.createScope(partyProfileId);
      this.scopes.set(partyProfileId, scope);
    }
    return scope;
  }

  private createScope(partyProfileId: string): PartyScopedRepository {
    const inScope = <T extends { partyProfileId: string }>(
      record: T | undefined,
    ) => (record?.partyProfileId === partyProfileId ? record : undefined);
    return {
      partyProfileId,
      characters: {
        create: (input) => this.createCharacter(partyProfileId, input),
        getById: async (id) => inScope(await this.db.characters.get(id)),
        getAll: () =>
          this.db.characters
            .where("partyProfileId")
            .equals(partyProfileId)
            .sortBy("name"),
        update: (id, changes) =>
          this.updateCharacter(partyProfileId, id, changes),
        delete: (id) => this.deleteCharacter(partyProfileId, id),
      },
      combatants: {
        create: (input) => this.createCombatant(partyProfileId, input),
        addFromMonster: (monster, options) =>
          this.addMonsterToStable(partyProfileId, monster, options),
        getById: async (id) => inScope(await this.db.combatants.get(id)),
        getAll: async () =>
          (
            await this.db.combatants
              .where("partyProfileId")
              .equals(partyProfileId)
              .toArray()
          ).sort(byCreation),
        update: (id, changes) =>
          this.updateCombatant(partyProfileId, id, changes),
        delete: (id) =>
          this.db.transaction("rw", this.db.combatants, async () => {
            if (inScope(await this.db.combatants.get(id))) {
              await this.db.combatants.delete(id);
            }
          }),
      },
      chat: {
        append: (message) => this.appendChatMessage(partyProfileId, message),
        list: () => chatRange(this.db, partyProfileId).toArray(),
        clear: async () => {
          await this.db.chatMessages
            .where("partyProfileId")
            .equals(partyProfileId)
            .delete();
        },
      },
    };
  }

  // ---- Profiles -----------------------------------------------------------

  /** Every table a profile cascade touches. */
  private get profileTables(): Table[] {
    const db = this.db;
    return [
      db.userProfiles,
      db.partyProfiles,
      db.characters,
      db.combatants,
      db.chatMessages,
      db.parties,
    ];
  }

  ensureDefaultProfile(): Promise<DefaultProfile> {
    return this.db.transaction(
      "rw",
      this.db.userProfiles,
      this.db.partyProfiles,
      async () => {
        const user =
          (await this.db.userProfiles.orderBy("createdAt").first()) ??
          (await this.createUser(DEFAULT_USER_NAME));
        const [oldest] = await this.db.partyProfiles
          .where("userId")
          .equals(user.id)
          .sortBy("createdAt");
        const partyProfile =
          oldest ?? (await this.createPartyProfile(user.id, DEFAULT_PARTY_NAME));
        return { user, partyProfile };
      },
    );
  }

  private async createUser(name: string): Promise<UserProfile> {
    const data = validate(userProfileInputSchema, "user profile", { name });
    const timestamp = this.now();
    const user = validate(userProfileSchema, "user profile", {
      ...data,
      id: this.generateId(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.userProfiles.add(user);
    return user;
  }

  private renameUser(id: string, name: string): Promise<UserProfile> {
    return this.db.transaction("rw", this.db.userProfiles, async () => {
      const existing = await this.db.userProfiles.get(id);
      if (!existing) throw new RecordNotFoundError("user profile", id);
      const updated = validate(userProfileSchema, "user profile", {
        ...existing,
        name,
        updatedAt: this.now(),
      });
      await this.db.userProfiles.put(updated);
      return updated;
    });
  }

  private deleteUser(id: string): Promise<void> {
    return this.db.transaction("rw", this.profileTables, async () => {
      if (!(await this.db.userProfiles.get(id))) return;
      if ((await this.db.userProfiles.count()) <= 1) {
        throw new LastUserProfileError(id);
      }
      const partyIds = (await this.db.partyProfiles
        .where("userId")
        .equals(id)
        .primaryKeys()) as string[];
      await this.deletePartyData(partyIds);
      await this.db.userProfiles.delete(id);
    });
  }

  private createPartyProfile(
    userId: string,
    name: string,
  ): Promise<PartyProfile> {
    return this.db.transaction(
      "rw",
      this.db.userProfiles,
      this.db.partyProfiles,
      async () => {
        const data = validate(partyProfileInputSchema, "party profile", {
          userId,
          name,
        });
        if (!(await this.db.userProfiles.get(userId))) {
          throw new RecordNotFoundError("user profile", userId);
        }
        const timestamp = this.now();
        const party = validate(partyProfileSchema, "party profile", {
          ...data,
          id: this.generateId(),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.db.partyProfiles.add(party);
        return party;
      },
    );
  }

  private renamePartyProfile(id: string, name: string): Promise<PartyProfile> {
    return this.db.transaction("rw", this.db.partyProfiles, async () => {
      const existing = await this.db.partyProfiles.get(id);
      if (!existing) throw new RecordNotFoundError("party profile", id);
      const updated = validate(partyProfileSchema, "party profile", {
        ...existing,
        name,
        updatedAt: this.now(),
      });
      await this.db.partyProfiles.put(updated);
      return updated;
    });
  }

  private deletePartyProfile(id: string): Promise<void> {
    return this.db.transaction("rw", this.profileTables, () =>
      this.deletePartyData([id]),
    );
  }

  /**
   * Deletes party profiles and everything scoped to them. Must run inside a
   * transaction over profileTables. Deleted characters are also dropped from
   * legacy parties so no characterIds dangle.
   */
  private async deletePartyData(partyIds: string[]): Promise<void> {
    if (partyIds.length === 0) return;
    const characterIds = (await this.db.characters
      .where("partyProfileId")
      .anyOf(partyIds)
      .primaryKeys()) as string[];
    if (characterIds.length > 0) {
      const gone = new Set(characterIds);
      const updatedAt = this.now();
      await this.db.parties
        .where("characterIds")
        .anyOf(characterIds)
        .modify((party) => {
          party.characterIds = party.characterIds.filter((c) => !gone.has(c));
          party.updatedAt = updatedAt;
        });
      await this.db.characters.bulkDelete(characterIds);
    }
    await this.db.combatants.where("partyProfileId").anyOf(partyIds).delete();
    await this.db.chatMessages.where("partyProfileId").anyOf(partyIds).delete();
    await this.db.partyProfiles.bulkDelete(partyIds);
    // Drop the cached scopes so the cache only grows with live parties. Harmless
    // if the transaction later aborts: forParty() just builds a fresh scope.
    for (const id of partyIds) this.scopes.delete(id);
  }

  /** Must be called inside a transaction that includes partyProfiles. */
  private async assertPartyProfileExists(id: string): Promise<void> {
    if (!(await this.db.partyProfiles.get(id))) {
      throw new RecordNotFoundError("party profile", id);
    }
  }

  // ---- Export / import ----------------------------------------------------

  exportUserProfile(userId: string): Promise<UserProfileExport> {
    const db = this.db;
    return db.transaction(
      "r",
      [db.userProfiles, db.partyProfiles, db.characters, db.combatants, db.chatMessages],
      async () => {
        const user = await db.userProfiles.get(userId);
        if (!user) throw new RecordNotFoundError("user profile", userId);
        const partyProfiles = await db.partyProfiles
          .where("userId")
          .equals(userId)
          .sortBy("createdAt");
        const ids = partyProfiles.map((p) => p.id);
        const chatMessages: ChatMessageRecord[] = [];
        for (const id of ids) chatMessages.push(...(await chatRange(db, id).toArray()));
        return {
          formatVersion: USER_PROFILE_EXPORT_FORMAT_VERSION,
          exportedAt: this.now(),
          user,
          partyProfiles,
          characters: await db.characters.where("partyProfileId").anyOf(ids).toArray(),
          combatants: (
            await db.combatants.where("partyProfileId").anyOf(ids).toArray()
          ).sort(byCreation),
          chatMessages,
        };
      },
    );
  }

  async importUserProfile(data: unknown): Promise<UserProfile> {
    // Validate everything before opening a write transaction, so a bad
    // export writes nothing.
    const copy = remapUserProfileExport(parseUserProfileExport(data), {
      generateId: this.generateId,
      now: this.now,
    });
    const db = this.db;
    await db.transaction(
      "rw",
      [db.userProfiles, db.partyProfiles, db.characters, db.combatants, db.chatMessages],
      async () => {
        await db.userProfiles.add(copy.user);
        await db.partyProfiles.bulkAdd(copy.partyProfiles);
        await db.characters.bulkAdd(copy.characters);
        await db.combatants.bulkAdd(copy.combatants);
        await db.chatMessages.bulkAdd(copy.chatMessages);
      },
    );
    return copy.user;
  }

  // ---- Party-scoped records -----------------------------------------------

  private appendChatMessage(
    partyProfileId: string,
    message: ChatMessageInput,
  ): Promise<ChatMessageRecord> {
    return this.db.transaction(
      "rw",
      this.db.partyProfiles,
      this.db.chatMessages,
      async () => {
        const data = validate(chatMessageInputSchema, "chat message", message);
        await this.assertPartyProfileExists(partyProfileId);
        // Picked inside the transaction so concurrent appends can't share a slot.
        const last = await chatRange(this.db, partyProfileId).last();
        const record = validate(chatMessageRecordSchema, "chat message", {
          ...data,
          id: this.generateId(),
          partyProfileId,
          sequence: last ? last.sequence + 1 : 0,
          createdAt: this.now(),
        });
        await this.db.chatMessages.add(record);
        return record;
      },
    );
  }

  private createCombatant(
    partyProfileId: string,
    input: CombatantInput,
  ): Promise<Combatant> {
    return this.db.transaction(
      "rw",
      this.db.partyProfiles,
      this.db.combatants,
      async () => {
        const data = validate(combatantInputSchema, "combatant", input);
        await this.assertPartyProfileExists(partyProfileId);
        const timestamp = this.now();
        const combatant = validate(combatantSchema, "combatant", {
          ...data,
          id: this.generateId(),
          partyProfileId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.db.combatants.add(combatant);
        return combatant;
      },
    );
  }

  /**
   * The label is picked inside the transaction so two quick adds of the same
   * monster can't both claim "Goblin 2". Numbering is per party profile.
   */
  private addMonsterToStable(
    partyProfileId: string,
    monster: MonsterStatBlock,
    options: AddMonsterOptions = {},
  ): Promise<Combatant> {
    return this.db.transaction(
      "rw",
      this.db.partyProfiles,
      this.db.combatants,
      async () => {
        const max = options.maxHp ?? monster.hitPoints;
        let label = options.label;
        if (label === undefined) {
          const taken = new Set(
            (
              await this.db.combatants
                .where("partyProfileId")
                .equals(partyProfileId)
                .toArray()
            ).map(combatantName),
          );
          label = monster.name;
          for (let n = 2; taken.has(label); n++) label = `${monster.name} ${n}`;
        }
        return this.createCombatant(partyProfileId, {
          monster,
          // The first of a kind just shows the monster's own name.
          label: label === monster.name ? undefined : label,
          // A block without HP (null) fails validation as a ValidationError.
          hitPoints: { max: max as number, current: max as number },
        });
      },
    );
  }

  private updateCombatant(
    partyProfileId: string,
    id: string,
    changes: CombatantUpdate,
  ): Promise<Combatant> {
    return this.db.transaction("rw", this.db.combatants, async () => {
      const existing = await this.db.combatants.get(id);
      if (existing?.partyProfileId !== partyProfileId) {
        throw new RecordNotFoundError("combatant", id);
      }
      const updated = validate(combatantSchema, "combatant", {
        ...existing,
        ...changes,
        id: existing.id,
        partyProfileId: existing.partyProfileId,
        createdAt: existing.createdAt,
        updatedAt: this.now(),
      });
      await this.db.combatants.put(updated);
      return updated;
    });
  }

  private createCharacter(
    partyProfileId: string,
    input: CharacterInput,
  ): Promise<Character> {
    return this.db.transaction(
      "rw",
      this.db.partyProfiles,
      this.db.characters,
      async () => {
        const data = validate(characterInputSchema, "character", input);
        await this.assertPartyProfileExists(partyProfileId);
        const timestamp = this.now();
        const character = validate(characterSchema, "character", {
          ...data,
          id: this.generateId(),
          partyProfileId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.db.characters.add(character);
        return character;
      },
    );
  }

  private updateCharacter(
    partyProfileId: string,
    id: string,
    changes: CharacterUpdate,
  ): Promise<Character> {
    return this.db.transaction("rw", this.db.characters, async () => {
      const existing = await this.db.characters.get(id);
      if (existing?.partyProfileId !== partyProfileId) {
        throw new RecordNotFoundError("character", id);
      }
      const updated = validate(characterSchema, "character", {
        ...existing,
        ...changes,
        id: existing.id,
        partyProfileId: existing.partyProfileId,
        createdAt: existing.createdAt,
        updatedAt: this.now(),
      });
      await this.db.characters.put(updated);
      return updated;
    });
  }

  /** No-op for a missing character or one in another party profile. */
  private deleteCharacter(partyProfileId: string, id: string): Promise<void> {
    return this.db.transaction(
      "rw",
      this.db.characters,
      this.db.parties,
      async () => {
        const existing = await this.db.characters.get(id);
        if (existing?.partyProfileId !== partyProfileId) return;
        const updatedAt = this.now();
        await this.db.parties
          .where("characterIds")
          .equals(id)
          .modify((party) => {
            party.characterIds = party.characterIds.filter((c) => c !== id);
            party.updatedAt = updatedAt;
          });
        await this.db.characters.delete(id);
      },
    );
  }

  // ---- Legacy parties -----------------------------------------------------

  /**
   * Runs `fn` in a read/write transaction over both tables. Every party write
   * goes through here so membership checks and the write are atomic with
   * respect to character deletion (no dangling characterIds).
   */
  private partyTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(
      "rw",
      this.db.characters,
      this.db.parties,
      fn,
    );
  }

  /** Must be called inside partyTransaction. */
  private async assertCharactersExist(ids: readonly string[]): Promise<void> {
    const found = await this.db.characters.bulkGet([...ids]);
    const missing = ids.find((_, i) => found[i] === undefined);
    if (missing !== undefined) {
      throw new RecordNotFoundError("character", missing);
    }
  }

  /** Must be called inside partyTransaction. */
  private async applyPartyUpdate(
    existing: Party,
    changes: PartyUpdate,
  ): Promise<Party> {
    const updated = validate(partySchema, "party", {
      ...existing,
      ...changes,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    });
    if (changes.characterIds !== undefined) {
      await this.assertCharactersExist(updated.characterIds);
    }
    await this.db.parties.put(updated);
    return updated;
  }

  private createParty(input: PartyInput): Promise<Party> {
    return this.partyTransaction(async () => {
      const data = validate(partyInputSchema, "party", input);
      const timestamp = this.now();
      const party = validate(partySchema, "party", {
        ...data,
        id: this.generateId(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.assertCharactersExist(party.characterIds);
      await this.db.parties.add(party);
      return party;
    });
  }

  private updateParty(id: string, changes: PartyUpdate): Promise<Party> {
    return this.partyTransaction(async () => {
      const existing = await this.db.parties.get(id);
      if (!existing) throw new RecordNotFoundError("party", id);
      return this.applyPartyUpdate(existing, changes);
    });
  }

  private addCharacterToParty(
    partyId: string,
    characterId: string,
  ): Promise<Party> {
    return this.partyTransaction(async () => {
      const party = await this.db.parties.get(partyId);
      if (!party) throw new RecordNotFoundError("party", partyId);
      if (!(await this.db.characters.get(characterId))) {
        throw new RecordNotFoundError("character", characterId);
      }
      if (party.characterIds.includes(characterId)) return party;
      return this.applyPartyUpdate(party, {
        characterIds: [...party.characterIds, characterId],
      });
    });
  }

  private removeCharacterFromParty(
    partyId: string,
    characterId: string,
  ): Promise<Party> {
    return this.partyTransaction(async () => {
      const party = await this.db.parties.get(partyId);
      if (!party) throw new RecordNotFoundError("party", partyId);
      if (!party.characterIds.includes(characterId)) return party;
      return this.applyPartyUpdate(party, {
        characterIds: party.characterIds.filter((id) => id !== characterId),
      });
    });
  }

  private listPartyCharacters(partyId: string): Promise<Character[]> {
    return this.db.transaction(
      "r",
      this.db.characters,
      this.db.parties,
      async () => {
        const party = await this.db.parties.get(partyId);
        if (!party) throw new RecordNotFoundError("party", partyId);
        const characters = await this.db.characters.bulkGet(
          party.characterIds,
        );
        return characters.filter((c): c is Character => c !== undefined);
      },
    );
  }
}

/** Creates a repository; tests pass a fresh DmFriendDb backed by fake-indexeddb. */
export function createDexieRepository(
  options?: DexieRepositoryOptions,
): DexieRepository {
  return new DexieRepository(options);
}
