import { z } from "zod";

import { monsterStatBlockSchema } from "@/lib/monsters/types";

/*
 * Zod schemas for the local data model. Each entity has two schemas:
 *  - an *input* schema for what callers supply on create (no id/timestamps)
 *  - a stored schema that adds the generated id and timestamps
 * Types are inferred from the schemas so they can never drift apart.
 *
 * Scoping: characters, combatants and chat messages each belong to exactly one
 * party profile. `partyProfileId` lives only on the *stored* schemas — the
 * repository injects it from the scope (`repository.forParty(id)`) on create,
 * so input schemas (and the forms built on them) never carry it and an update
 * can never move a record to another party.
 */

export const ABILITIES = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
] as const;

export const SKILLS = [
  "acrobatics",
  "animalHandling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleightOfHand",
  "stealth",
  "survival",
] as const;

export const CONDITIONS = [
  "blinded",
  "charmed",
  "deafened",
  "exhaustion",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
] as const;

export const abilitySchema = z.enum(ABILITIES);
export const skillSchema = z.enum(SKILLS);
export const conditionSchema = z.enum(CONDITIONS);

export type Ability = z.infer<typeof abilitySchema>;
export type Skill = z.infer<typeof skillSchema>;
export type Condition = z.infer<typeof conditionSchema>;

const abilityScore = z.number().int().min(1).max(30);

export const abilityScoresSchema = z.object({
  strength: abilityScore,
  dexterity: abilityScore,
  constitution: abilityScore,
  intelligence: abilityScore,
  wisdom: abilityScore,
  charisma: abilityScore,
});

export type AbilityScores = z.infer<typeof abilityScoresSchema>;

/** Current HP is kept within 0..max; temporary HP is tracked separately. */
export const hitPointsSchema = z
  .object({
    max: z.number().int().positive(),
    current: z.number().int().min(0),
    temporary: z.number().int().min(0).default(0),
  })
  .refine((hp) => hp.current <= hp.max, {
    message: "current hit points cannot exceed max",
    path: ["current"],
  });

export type HitPoints = z.infer<typeof hitPointsSchema>;

/** Rejects duplicate entries in a list of enum values. */
function uniqueList<T extends z.ZodType<string>>(item: T) {
  return z
    .array(item)
    .refine((list) => new Set(list).size === list.length, {
      message: "entries must be unique",
    });
}

const timestamp = z.iso.datetime();

export const characterInputSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  race: z.string().trim().optional(),
  className: z.string().trim().min(1, "class is required"),
  level: z.number().int().min(1).max(20),
  armorClass: z.number().int().min(0),
  hitPoints: hitPointsSchema,
  abilityScores: abilityScoresSchema,
  savingThrowProficiencies: uniqueList(abilitySchema).default([]),
  skillProficiencies: uniqueList(skillSchema).default([]),
  passivePerception: z.number().int().min(0).optional(),
  conditions: uniqueList(conditionSchema).default([]),
  notes: z.string().optional(),
  /** Reference to the source scan (e.g. a blob id or data URL); populated by the scanner later. */
  rawScan: z.string().nullable().optional(),
});

export const characterSchema = characterInputSchema.extend({
  id: z.uuid(),
  /** The owning party profile; injected by the repository, never by callers. */
  partyProfileId: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** What callers pass to create a character (defaults may be omitted). */
export type CharacterInput = z.input<typeof characterInputSchema>;
/** A character as stored and returned by the repository. */
export type Character = z.infer<typeof characterSchema>;
/** Fields that may be changed by an update; nested objects are replaced wholesale. */
export type CharacterUpdate = Partial<CharacterInput>;

/*
 * Legacy party (a named list of character ids). Superseded by party *profiles*,
 * which scope characters/combatants/chat directly. The table and its API are
 * kept as-is so no existing data is lost, but new code should not use it.
 */
export const partyInputSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  characterIds: uniqueList(z.uuid()).default([]),
});

export const partySchema = partyInputSchema.extend({
  id: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type PartyInput = z.input<typeof partyInputSchema>;
export type Party = z.infer<typeof partySchema>;
export type PartyUpdate = Partial<PartyInput>;

/*
 * A combatant is a monster saved to the stable, with live combat state. The
 * full normalized stat block is embedded at add-time so an entry is
 * self-contained: it renders (and can ground the chat) offline, without
 * re-fetching from Open5e. HP reuses the character rules (0..max, temporary
 * tracked separately) so the roster and the stable agree on what valid HP is.
 */
export const combatantInputSchema = z.object({
  /** Snapshot of the monster's stat block: slug, name, AC, CR, actions, … */
  monster: monsterStatBlockSchema.refine((monster) => monster.name.trim() !== "", {
    message: "monster name is required",
    path: ["name"],
  }),
  /** Display name for telling duplicates apart ("Goblin 2"); defaults to the monster's name. */
  label: z.string().trim().min(1, "label cannot be blank").optional(),
  hitPoints: hitPointsSchema,
  conditions: uniqueList(conditionSchema).default([]),
  notes: z.string().optional(),
});

export const combatantSchema = combatantInputSchema.extend({
  id: z.uuid(),
  /** The owning party profile; injected by the repository, never by callers. */
  partyProfileId: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type CombatantInput = z.input<typeof combatantInputSchema>;
export type Combatant = z.infer<typeof combatantSchema>;
/** Fields that may be changed by an update; nested objects are replaced wholesale. */
export type CombatantUpdate = Partial<CombatantInput>;

/** The name a combatant is shown (and referred to) by: its label, else the monster's name. */
export function combatantName(combatant: Pick<Combatant, "label" | "monster">): string {
  return combatant.label ?? combatant.monster.name;
}

/*
 * Profiles. A user profile owns many party profiles; each party profile is the
 * scope for its own characters, monster stable and chat history. Everything is
 * local to the device — there is no auth.
 */
const profileName = z.string().trim().min(1, "name is required");

export const userProfileInputSchema = z.object({
  name: profileName,
});

export const userProfileSchema = userProfileInputSchema.extend({
  id: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type UserProfileInput = z.input<typeof userProfileInputSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;

export const partyProfileInputSchema = z.object({
  /** The owning user profile. */
  userId: z.uuid(),
  name: profileName,
});

export const partyProfileSchema = partyProfileInputSchema.extend({
  id: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type PartyProfileInput = z.input<typeof partyProfileInputSchema>;
export type PartyProfile = z.infer<typeof partyProfileSchema>;

export const CHAT_MESSAGE_ROLES = ["user", "assistant"] as const;

/** One persisted chat turn. Content is stored verbatim (not trimmed: it may be markdown). */
export const chatMessageInputSchema = z.object({
  role: z.enum(CHAT_MESSAGE_ROLES),
  content: z.string().min(1, "content is required"),
});

export const chatMessageRecordSchema = chatMessageInputSchema.extend({
  id: z.uuid(),
  /** The owning party profile; injected by the repository, never by callers. */
  partyProfileId: z.uuid(),
  /**
   * Position in the party's conversation (0, 1, 2, …), assigned on append.
   * Orders the history; timestamps alone can tie within a millisecond.
   */
  sequence: z.number().int().min(0),
  createdAt: timestamp,
});

export type ChatMessageInput = z.input<typeof chatMessageInputSchema>;
export type ChatMessageRecord = z.infer<typeof chatMessageRecordSchema>;
