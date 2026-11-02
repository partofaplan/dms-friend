import { z } from "zod";

/*
 * Contracts for GET /api/monsters, plus the pure normalizer that maps a raw
 * Open5e monster onto our combat-focused stat block.
 *
 * This module is safe to import from client code: it only depends on Zod and
 * contains no server logic, network access, or environment access.
 */

export const MAX_SEARCH_LENGTH = 100;
export const MAX_SLUG_LENGTH = 100;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Query params for GET /api/monsters. Exactly one mode:
 *   ?search=<name>  → MonsterSearchResponseBody
 *   ?slug=<slug>    → MonsterDetailResponseBody
 */
export const monsterQuerySchema = z
  .object({
    search: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
    slug: z.string().trim().toLowerCase().max(MAX_SLUG_LENGTH).optional(),
  })
  .transform((query, ctx) => {
    // Presence is checked before emptiness: supplying both params is an error
    // even when one of them is blank.
    if (query.search !== undefined && query.slug !== undefined) {
      ctx.addIssue({ code: "custom", message: "Provide either search or slug, not both." });
      return z.NEVER;
    }
    const search = query.search || undefined;
    const slug = query.slug || undefined;
    if (slug) {
      if (!SLUG_PATTERN.test(slug)) {
        ctx.addIssue({ code: "custom", path: ["slug"], message: "slug is invalid" });
        return z.NEVER;
      }
      return { mode: "slug" as const, slug };
    }
    if (search) return { mode: "search" as const, search };
    ctx.addIssue({ code: "custom", message: "A non-empty search or slug is required." });
    return z.NEVER;
  });

export type MonsterQuery = z.output<typeof monsterQuerySchema>;

export const ABILITIES = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
] as const;

export type Ability = (typeof ABILITIES)[number];

export const ABILITY_ABBREVIATIONS: Record<Ability, string> = {
  strength: "STR",
  dexterity: "DEX",
  constitution: "CON",
  intelligence: "INT",
  wisdom: "WIS",
  charisma: "CHA",
};

/** One row in the search results list. */
export interface MonsterSummary {
  slug: string;
  name: string;
  size: string;
  type: string;
  /** Numeric CR for sorting/filtering (e.g. 0.25), or null if unknown. */
  cr: number | null;
  /** Display CR (e.g. "1/4", "11"), or null if unknown. */
  challengeRating: string | null;
}

export interface MonsterFeature {
  name: string;
  desc: string;
}

export interface MonsterSpeed {
  /** "walk", "fly", "swim", "climb", "burrow", … */
  mode: string;
  feet: number;
}

export interface MonsterBonus {
  name: string;
  bonus: number;
}

/** Combat-focused stat block. Absent text fields are "" and absent lists are []. */
export interface MonsterStatBlock extends MonsterSummary {
  subtype: string;
  alignment: string;
  armorClass: number | null;
  armorDesc: string;
  hitPoints: number | null;
  hitDice: string;
  speed: MonsterSpeed[];
  /** Can hover while flying. */
  hover: boolean;
  /** Ability scores; null when the source omits one. */
  abilities: Record<Ability, number | null>;
  /** Saving throw bonuses, only those the source lists, in ability order. */
  savingThrows: MonsterBonus[];
  skills: MonsterBonus[];
  damageVulnerabilities: string;
  damageResistances: string;
  damageImmunities: string;
  conditionImmunities: string;
  senses: string;
  languages: string;
  specialAbilities: MonsterFeature[];
  actions: MonsterFeature[];
  bonusActions: MonsterFeature[];
  reactions: MonsterFeature[];
  legendaryDesc: string;
  legendaryActions: MonsterFeature[];
}

/** GET /api/monsters?search= 200 response body. Empty `results` is not an error. */
export interface MonsterSearchResponseBody {
  results: MonsterSummary[];
}

/** GET /api/monsters?slug= 200 response body. */
export interface MonsterDetailResponseBody {
  monster: MonsterStatBlock;
}

export const MONSTER_ERROR_KINDS = ["bad_request", "not_found", "upstream_error", "timeout"] as const;

export type MonsterErrorKind = (typeof MONSTER_ERROR_KINDS)[number];

/** Body of every non-2xx response from /api/monsters. */
export interface MonsterErrorResponseBody {
  error: { kind: MonsterErrorKind; message: string };
}

/* ── Normalizer ──────────────────────────────────────────────────────────── */

/*
 * Local bounds on normalized output, so a malformed or oversized upstream
 * payload can't produce an unbounded stat block (in the cache or the UI).
 * Generous next to real SRD data; extras are dropped and long text truncated.
 */
/** Short text fields: slug, name, type, senses, languages, feature names, … */
export const MAX_FIELD_LENGTH = 500;
/** Long text fields: feature descriptions and the legendary preamble. */
export const MAX_DESC_LENGTH = 5_000;
/** Entries kept per feature section (actions, traits, legendary actions, …). */
export const MAX_SECTION_ENTRIES = 50;
/** Speed modes and skills kept. */
export const MAX_BONUS_ENTRIES = 30;

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed string capped at `maxLength`, or "" for null/missing/non-string. */
function text(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength).trim() : "";
}

/** Finite number (numeric strings accepted), or null. */
function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function features(value: unknown): MonsterFeature[] {
  if (!Array.isArray(value)) return [];
  const result: MonsterFeature[] = [];
  for (const item of value) {
    if (result.length >= MAX_SECTION_ENTRIES) break;
    if (!isRecord(item)) continue;
    const name = text(item.name);
    const desc = text(item.desc, MAX_DESC_LENGTH);
    if (name || desc) result.push({ name, desc });
  }
  return result;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// A Map, not an object literal, so inherited keys like "toString" never match.
const CR_FRACTIONS = new Map<string, number>([
  ["1/8", 0.125],
  ["1/4", 0.25],
  ["1/2", 0.5],
]);

/** "1/4" → 0.25, "11" → 11. */
export function parseChallengeRating(value: string): number | null {
  const trimmed = value.trim();
  return CR_FRACTIONS.get(trimmed) ?? finite(trimmed);
}

/** 0.25 → "1/4", 11 → "11". */
export function formatChallengeRating(cr: number): string {
  const fraction = [...CR_FRACTIONS].find(([, value]) => value === cr);
  return fraction ? fraction[0] : String(cr);
}

function challenge(raw: RawRecord): Pick<MonsterSummary, "cr" | "challengeRating"> {
  const label = text(raw.challenge_rating);
  const numeric = finite(raw.cr);
  return {
    cr: numeric ?? (label ? parseChallengeRating(label) : null),
    challengeRating: label || (numeric !== null ? formatChallengeRating(numeric) : null),
  };
}

/** Score → modifier: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Signed bonus: 3 → "+3", -1 → "-1", 0 → "+0". */
export function formatBonus(bonus: number): string {
  return bonus >= 0 ? `+${bonus}` : `${bonus}`;
}

/** 16 → "16 (+3)". */
export function formatAbilityScore(score: number): string {
  return `${score} (${formatBonus(abilityModifier(score))})`;
}

/** [{walk,30},{fly,60}], hover → "30 ft., fly 60 ft. (hover)". */
export function formatSpeed(speed: MonsterSpeed[], hover = false): string {
  return speed
    .map(({ mode, feet }) => {
      const base = mode === "walk" ? `${feet} ft.` : `${mode} ${feet} ft.`;
      return mode === "fly" && hover ? `${base} (hover)` : base;
    })
    .join(", ");
}

function speeds(value: unknown): Pick<MonsterStatBlock, "speed" | "hover"> {
  if (!isRecord(value)) return { speed: [], hover: false };
  const speed: MonsterSpeed[] = [];
  for (const [mode, feet] of Object.entries(value)) {
    if (speed.length >= MAX_BONUS_ENTRIES) break;
    const n = finite(feet);
    if (n !== null) speed.push({ mode: text(mode), feet: n });
  }
  // Walking speed reads first, as in printed stat blocks.
  speed.sort((a, b) => Number(b.mode === "walk") - Number(a.mode === "walk"));
  return { speed, hover: value.hover === true };
}

function skills(value: unknown): MonsterBonus[] {
  if (!isRecord(value)) return [];
  const result: MonsterBonus[] = [];
  for (const [skill, bonus] of Object.entries(value)) {
    if (result.length >= MAX_BONUS_ENTRIES) break;
    const n = finite(bonus);
    if (n !== null) result.push({ name: capitalize(text(skill)), bonus: n });
  }
  return result;
}

/** Maps one raw Open5e search result to a list row; null if it lacks a slug or name. */
export function normalizeMonsterSummary(raw: unknown): MonsterSummary | null {
  if (!isRecord(raw)) return null;
  const slug = text(raw.slug);
  const name = text(raw.name);
  if (!slug || !name) return null;
  return { slug, name, size: text(raw.size), type: text(raw.type), ...challenge(raw) };
}

/**
 * Maps a raw Open5e monster to our stat block, tolerating null, missing, and
 * mistyped fields. Returns null only when the slug or name is missing.
 */
export function normalizeMonster(raw: unknown): MonsterStatBlock | null {
  const summary = normalizeMonsterSummary(raw);
  if (!summary || !isRecord(raw)) return null;

  const abilities = Object.fromEntries(
    ABILITIES.map((ability) => [ability, finite(raw[ability])]),
  ) as Record<Ability, number | null>;

  const savingThrows = ABILITIES.flatMap((ability) => {
    const bonus = finite(raw[`${ability}_save`]);
    return bonus === null ? [] : [{ name: ABILITY_ABBREVIATIONS[ability], bonus }];
  });

  return {
    ...summary,
    subtype: text(raw.subtype),
    alignment: text(raw.alignment),
    armorClass: finite(raw.armor_class),
    armorDesc: text(raw.armor_desc),
    hitPoints: finite(raw.hit_points),
    hitDice: text(raw.hit_dice),
    ...speeds(raw.speed),
    abilities,
    savingThrows,
    skills: skills(raw.skills),
    damageVulnerabilities: text(raw.damage_vulnerabilities),
    damageResistances: text(raw.damage_resistances),
    damageImmunities: text(raw.damage_immunities),
    conditionImmunities: text(raw.condition_immunities),
    senses: text(raw.senses),
    languages: text(raw.languages),
    specialAbilities: features(raw.special_abilities),
    actions: features(raw.actions),
    bonusActions: features(raw.bonus_actions),
    reactions: features(raw.reactions),
    legendaryDesc: text(raw.legendary_desc, MAX_DESC_LENGTH),
    legendaryActions: features(raw.legendary_actions),
  };
}
