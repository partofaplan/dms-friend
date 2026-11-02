import { z } from "zod";
import type { MonsterStatBlock } from "@/lib/monsters/types";

import type {
  Character,
  CharacterInput,
  CharacterUpdate,
  Combatant,
  CombatantInput,
  CombatantUpdate,
  Party,
  PartyInput,
  PartyUpdate,
} from "./schema";

/*
 * Storage-agnostic repository contract. The app talks only to this interface,
 * so the Dexie implementation can later be swapped for (or wrapped by) a
 * cloud-synced backend without touching callers.
 */

export interface CharacterRepository {
  create(input: CharacterInput): Promise<Character>;
  getById(id: string): Promise<Character | undefined>;
  getAll(): Promise<Character[]>;
  /** Applies a shallow partial update; throws RecordNotFoundError if missing. */
  update(id: string, changes: CharacterUpdate): Promise<Character>;
  /** Deletes the character and removes it from any party. No-op if missing. */
  delete(id: string): Promise<void>;
}

export interface PartyRepository {
  create(input: PartyInput): Promise<Party>;
  getById(id: string): Promise<Party | undefined>;
  getAll(): Promise<Party[]>;
  update(id: string, changes: PartyUpdate): Promise<Party>;
  /** Deletes the party only; its characters are kept. No-op if missing. */
  delete(id: string): Promise<void>;
  /** Idempotent: adding a character already in the party is a no-op. */
  addCharacter(partyId: string, characterId: string): Promise<Party>;
  /** Idempotent: removing a character not in the party is a no-op. */
  removeCharacter(partyId: string, characterId: string): Promise<Party>;
  /** The party's characters in party order; throws RecordNotFoundError if the party is missing. */
  listCharacters(partyId: string): Promise<Character[]>;
}

export interface AddMonsterOptions {
  /** Display name; when omitted, duplicates are auto-numbered ("Goblin", "Goblin 2"). */
  label?: string;
  /** Overrides the stat block's hit points (e.g. rolled HP, or a block without HP). */
  maxHp?: number;
}

/** The monster stable: saved monsters with live combat state, in the order added. */
export interface CombatantRepository {
  create(input: CombatantInput): Promise<Combatant>;
  /**
   * Saves a stat block to the stable at full HP with no conditions. The same
   * monster may be added any number of times; each is a distinct combatant.
   * Throws ValidationError if the block has no hit points and no maxHp is given.
   */
  addFromMonster(
    monster: MonsterStatBlock,
    options?: AddMonsterOptions,
  ): Promise<Combatant>;
  getById(id: string): Promise<Combatant | undefined>;
  /** Every combatant, oldest first (the order they joined the fight). */
  getAll(): Promise<Combatant[]>;
  /** Applies a shallow partial update; throws RecordNotFoundError if missing. */
  update(id: string, changes: CombatantUpdate): Promise<Combatant>;
  /** No-op if missing. */
  delete(id: string): Promise<void>;
}

export interface Repository {
  characters: CharacterRepository;
  parties: PartyRepository;
  combatants: CombatantRepository;
}

export class ValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(entity: string, error: z.ZodError) {
    super(`Invalid ${entity}:\n${z.prettifyError(error)}`);
    this.name = "ValidationError";
    this.issues = error.issues;
  }
}

// Not named "NotFoundError": Dexie remaps errors whose name matches its own
// error types, which would break instanceof checks for callers.
export class RecordNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "RecordNotFoundError";
  }
}
