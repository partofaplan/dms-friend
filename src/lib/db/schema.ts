import { z } from "zod";

/*
 * Zod schemas for the local data model. Each entity has two schemas:
 *  - an *input* schema for what callers supply on create (no id/timestamps)
 *  - a stored schema that adds the generated id and timestamps
 * Types are inferred from the schemas so they can never drift apart.
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
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** What callers pass to create a character (defaults may be omitted). */
export type CharacterInput = z.input<typeof characterInputSchema>;
/** A character as stored and returned by the repository. */
export type Character = z.infer<typeof characterSchema>;
/** Fields that may be changed by an update; nested objects are replaced wholesale. */
export type CharacterUpdate = Partial<CharacterInput>;

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
