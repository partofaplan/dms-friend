import Dexie, { type DexieOptions, type EntityTable } from "dexie";
import type { z } from "zod";
import {
  RecordNotFoundError,
  ValidationError,
  type AddMonsterOptions,
  type CharacterRepository,
  type CombatantRepository,
  type PartyRepository,
  type Repository,
} from "./repository";
import type { MonsterStatBlock } from "@/lib/monsters/types";

import {
  characterInputSchema,
  characterSchema,
  combatantInputSchema,
  combatantName,
  combatantSchema,
  partyInputSchema,
  partySchema,
  type Character,
  type CharacterInput,
  type CharacterUpdate,
  type Combatant,
  type CombatantInput,
  type CombatantUpdate,
  type Party,
  type PartyInput,
  type PartyUpdate,
} from "./schema";

export const DEFAULT_DB_NAME = "dm-friend";

export class DmFriendDb extends Dexie {
  characters!: EntityTable<Character, "id">;
  parties!: EntityTable<Party, "id">;

  combatants!: EntityTable<Combatant, "id">;

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

export class DexieRepository implements Repository {
  readonly db: DmFriendDb;
  readonly characters: CharacterRepository;
  readonly parties: PartyRepository;
  readonly combatants: CombatantRepository;

  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(options: DexieRepositoryOptions = {}) {
    this.db = options.db ?? new DmFriendDb();
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());

    this.characters = {
      create: (input) => this.createCharacter(input),
      getById: (id) => this.db.characters.get(id),
      getAll: () => this.db.characters.orderBy("name").toArray(),
      update: (id, changes) => this.updateCharacter(id, changes),
      delete: (id) => this.deleteCharacter(id),
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

    this.combatants = {
      create: (input) => this.createCombatant(input),
      addFromMonster: (monster, options) =>
        this.addMonsterToStable(monster, options),
      getById: (id) => this.db.combatants.get(id),
      getAll: () => this.db.combatants.orderBy("createdAt").toArray(),
      update: (id, changes) => this.updateCombatant(id, changes),
      delete: (id) => this.db.combatants.delete(id),
    };
  }

  private async createCombatant(input: CombatantInput): Promise<Combatant> {
    const data = validate(combatantInputSchema, "combatant", input);
    const timestamp = this.now();
    const combatant = validate(combatantSchema, "combatant", {
      ...data,
      id: this.generateId(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.combatants.add(combatant);
    return combatant;
  }

  /**
   * The label is picked inside the transaction so two quick adds of the same
   * monster can't both claim "Goblin 2".
   */
  private addMonsterToStable(
    monster: MonsterStatBlock,
    options: AddMonsterOptions = {},
  ): Promise<Combatant> {
    return this.db.transaction("rw", this.db.combatants, async () => {
      const max = options.maxHp ?? monster.hitPoints;
      let label = options.label;
      if (label === undefined) {
        const taken = new Set(
          (await this.db.combatants.toArray()).map(combatantName),
        );
        label = monster.name;
        for (let n = 2; taken.has(label); n++) label = `${monster.name} ${n}`;
      }
      return this.createCombatant({
        monster,
        // The first of a kind just shows the monster's own name.
        label: label === monster.name ? undefined : label,
        // A block without HP (null) fails validation as a ValidationError.
        hitPoints: { max: max as number, current: max as number },
      });
    });
  }

  private updateCombatant(
    id: string,
    changes: CombatantUpdate,
  ): Promise<Combatant> {
    return this.db.transaction("rw", this.db.combatants, async () => {
      const existing = await this.db.combatants.get(id);
      if (!existing) throw new RecordNotFoundError("combatant", id);
      const updated = validate(combatantSchema, "combatant", {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: this.now(),
      });
      await this.db.combatants.put(updated);
      return updated;
    });
  }

  private async createCharacter(input: CharacterInput): Promise<Character> {
    const data = validate(characterInputSchema, "character", input);
    const timestamp = this.now();
    const character = validate(characterSchema, "character", {
      ...data,
      id: this.generateId(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.characters.add(character);
    return character;
  }

  private updateCharacter(
    id: string,
    changes: CharacterUpdate,
  ): Promise<Character> {
    return this.db.transaction("rw", this.db.characters, async () => {
      const existing = await this.db.characters.get(id);
      if (!existing) throw new RecordNotFoundError("character", id);
      const updated = validate(characterSchema, "character", {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: this.now(),
      });
      await this.db.characters.put(updated);
      return updated;
    });
  }

  private deleteCharacter(id: string): Promise<void> {
    return this.db.transaction(
      "rw",
      this.db.characters,
      this.db.parties,
      async () => {
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
