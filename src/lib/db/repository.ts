import { z } from "zod";
import type { MonsterStatBlock } from "@/lib/monsters/types";

import type {
  Character,
  CharacterInput,
  CharacterUpdate,
  ChatMessageInput,
  ChatMessageRecord,
  Combatant,
  CombatantInput,
  CombatantUpdate,
  Party,
  PartyInput,
  PartyProfile,
  PartyUpdate,
  UserProfile,
} from "./schema";
import type { UserProfileExport } from "./transfer";

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

/** A party profile's chat history, oldest first. */
export interface ChatHistoryRepository {
  /** Appends a turn at the end of the conversation; throws RecordNotFoundError if the party profile is missing. */
  append(message: ChatMessageInput): Promise<ChatMessageRecord>;
  /** Every turn in conversation order. */
  list(): Promise<ChatMessageRecord[]>;
  /** Deletes the whole conversation. */
  clear(): Promise<void>;
}

/**
 * Everything that belongs to one party profile. Reads only ever see the
 * party's own records (another party's id reads as missing); creates stamp
 * the party's id and throw RecordNotFoundError if the party profile does not
 * exist, so nothing can be orphaned.
 */
export interface PartyScopedRepository {
  readonly partyProfileId: string;
  characters: CharacterRepository;
  /** Auto-numbering ("Goblin 2") counts only this party's stable. */
  combatants: CombatantRepository;
  chat: ChatHistoryRepository;
}

export interface UserProfileRepository {
  create(name: string): Promise<UserProfile>;
  getById(id: string): Promise<UserProfile | undefined>;
  /** Every user profile, sorted by name. */
  getAll(): Promise<UserProfile[]>;
  /** Throws ValidationError for a blank name, RecordNotFoundError if missing. */
  rename(id: string, name: string): Promise<UserProfile>;
  /**
   * Deletes the user with all of its party profiles and their characters,
   * combatants and chat, atomically. No-op if missing. Throws
   * LastUserProfileError instead of deleting the only remaining user.
   */
  delete(id: string): Promise<void>;
}

export interface PartyProfileRepository {
  /** Throws RecordNotFoundError if the user profile is missing. */
  create(userId: string, name: string): Promise<PartyProfile>;
  getById(id: string): Promise<PartyProfile | undefined>;
  /** The user's party profiles, sorted by name. */
  listByUser(userId: string): Promise<PartyProfile[]>;
  /** Throws ValidationError for a blank name, RecordNotFoundError if missing. */
  rename(id: string, name: string): Promise<PartyProfile>;
  /**
   * Deletes the party profile with its characters, combatants and chat,
   * atomically. No-op if missing. A user may be left with no parties; picking
   * another active party is the caller's job (see ensureDefaultProfile).
   */
  delete(id: string): Promise<void>;
}

export interface DefaultProfile {
  user: UserProfile;
  partyProfile: PartyProfile;
}

/**
 * The pre-profiles, unscoped view. `characters` and `combatants` here act on
 * the *default* party profile (see AppRepository.ensureDefaultProfile), so
 * screens that predate profiles keep working unchanged.
 *
 * @deprecated Use AppRepository.forParty(partyProfileId); this shape goes away
 * once the screens are scoped to the active party.
 */
export interface Repository {
  characters: CharacterRepository;
  /** Legacy named lists of characters, superseded by party profiles. */
  parties: PartyRepository;
  combatants: CombatantRepository;
}

/**
 * The full storage API: user/party profiles, party-scoped data, and profile
 * export/import. Extends the legacy Repository only for back-compat.
 */
export interface AppRepository extends Repository {
  users: UserProfileRepository;
  partyProfiles: PartyProfileRepository;
  /**
   * The characters, monster stable and chat history of one party profile.
   * Returns the same object for the same id (safe as a React dependency).
   */
  forParty(partyProfileId: string): PartyScopedRepository;
  /**
   * The oldest user profile and its oldest party profile, creating
   * "Default User" / "Default Party" when they don't exist yet (a fresh
   * install, or a user whose last party was deleted). Idempotent.
   */
  ensureDefaultProfile(): Promise<DefaultProfile>;
  /** A self-contained snapshot of a user and everything under it. Throws RecordNotFoundError if missing. */
  exportUserProfile(userId: string): Promise<UserProfileExport>;
  /**
   * Re-creates an export (object or JSON string) as a NEW user profile with
   * fresh ids throughout; never touches existing records. Throws ImportError
   * — writing nothing — if the data isn't a valid export.
   */
  importUserProfile(data: unknown): Promise<UserProfile>;
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

/** There must always be at least one user profile on the device. */
export class LastUserProfileError extends Error {
  constructor(id: string) {
    super(`cannot delete the last user profile: ${id}`);
    this.name = "LastUserProfileError";
  }
}
