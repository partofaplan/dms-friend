import Dexie, { type DexieOptions, type EntityTable } from "dexie";
import type { z } from "zod";
import {
  RecordNotFoundError,
  ValidationError,
  type CharacterRepository,
  type PartyRepository,
  type Repository,
} from "./repository";
import {
  characterInputSchema,
  characterSchema,
  partyInputSchema,
  partySchema,
  type Character,
  type CharacterInput,
  type CharacterUpdate,
  type Party,
  type PartyInput,
  type PartyUpdate,
} from "./schema";

export const DEFAULT_DB_NAME = "dm-friend";

export class DmFriendDb extends Dexie {
  characters!: EntityTable<Character, "id">;
  parties!: EntityTable<Party, "id">;

  constructor(name: string = DEFAULT_DB_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      characters: "id, name, updatedAt",
      // Multi-entry index lets us find every party containing a character.
      parties: "id, name, *characterIds, updatedAt",
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

  private async createParty(input: PartyInput): Promise<Party> {
    const data = validate(partyInputSchema, "party", input);
    const timestamp = this.now();
    const party = validate(partySchema, "party", {
      ...data,
      id: this.generateId(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.db.parties.add(party);
    return party;
  }

  private updateParty(id: string, changes: PartyUpdate): Promise<Party> {
    return this.db.transaction("rw", this.db.parties, async () => {
      const existing = await this.db.parties.get(id);
      if (!existing) throw new RecordNotFoundError("party", id);
      const updated = validate(partySchema, "party", {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: this.now(),
      });
      await this.db.parties.put(updated);
      return updated;
    });
  }

  private addCharacterToParty(
    partyId: string,
    characterId: string,
  ): Promise<Party> {
    return this.db.transaction(
      "rw",
      this.db.characters,
      this.db.parties,
      async () => {
        const party = await this.db.parties.get(partyId);
        if (!party) throw new RecordNotFoundError("party", partyId);
        if (!(await this.db.characters.get(characterId))) {
          throw new RecordNotFoundError("character", characterId);
        }
        if (party.characterIds.includes(characterId)) return party;
        return this.updateParty(partyId, {
          characterIds: [...party.characterIds, characterId],
        });
      },
    );
  }

  private removeCharacterFromParty(
    partyId: string,
    characterId: string,
  ): Promise<Party> {
    return this.db.transaction("rw", this.db.parties, async () => {
      const party = await this.db.parties.get(partyId);
      if (!party) throw new RecordNotFoundError("party", partyId);
      if (!party.characterIds.includes(characterId)) return party;
      return this.updateParty(partyId, {
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
