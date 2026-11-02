import type { Character } from "@/lib/db/schema";
import { clip } from "@/lib/text/clip";

/*
 * Compact, length-capped one-line descriptions of party members, shared by
 * the system prompt's party summary and its "Referenced now" block, plus the
 * short name handle ("Thorin" for "Thorin Oakenshield") both the prompt and
 * the name resolver key on. Pure functions.
 */

/** Characters kept per free-text note. */
export const MAX_NOTE_LENGTH = 120;
/** Characters kept per short field (names, classes, monster defenses, …). */
export const MAX_SHORT_FIELD_LENGTH = 60;

/** Characters of a stored name considered when deriving handles or matching. */
export const MAX_NAME_LENGTH = 200;

/**
 * Words never used as a name handle: titles and function words that are not
 * plausibly names ("Sir Gareth" is "Gareth", "The Bard" is "Bard").
 */
const NOT_HANDLES = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "at", "by", "for", "from", "with",
  "is", "it", "be", "he", "she", "they", "him", "his", "her", "its", "my", "our", "your",
  "this", "that", "who", "what", "how", "can",
  "sir", "lady", "lord", "dame", "master", "mistress", "mr", "mrs", "ms", "dr",
  "captain", "king", "queen", "prince", "princess", "brother", "sister", "father", "mother",
  "old", "young", "big", "little", "great", "saint", "st",
]);

/**
 * Everyday words that are also plausible names ("Will", "Hope", "The Bard").
 * A name made only of these (and NOT_HANDLES words) still resolves, but only
 * with a proper-noun signal (see resolve-names), so "can a bard heal?" stays
 * a rules question.
 */
const COMMON_WORD_NAMES = new Set([
  "will", "may", "hope", "grace", "faith", "joy", "mercy", "honor", "patience", "constance",
  "rose", "lily", "ivy", "iris", "violet", "hazel", "holly", "heather", "daisy", "ruby",
  "pearl", "amber", "jade", "dawn", "summer", "autumn", "winter", "storm", "sky", "river",
  "stone", "ash", "rowan", "sage", "wren", "raven", "robin", "hunter", "archer", "smith",
  "bard", "rogue", "cleric", "mage", "wizard", "sorcerer", "warlock", "druid", "monk",
  "ranger", "paladin", "fighter", "barbarian", "priest", "knight", "guard", "scout",
  "thief", "healer", "witch", "hero", "stranger", "wanderer",
  "red", "grey", "gray", "black", "white", "green", "frank", "bill", "jack", "mark", "chase",
]);

/** A word of a name or message: letters/digits, accents removed. */
export interface NameWord {
  /** As written: "Thorin". */
  text: string;
  /** Lowercase: "thorin". */
  token: string;
  /** Span in `normalized`. */
  start: number;
  end: number;
}

/** `value` with accents removed, split into letter/digit words. */
export function nameWords(value: string): { normalized: string; words: NameWord[] } {
  const normalized = value.normalize("NFKD").replace(/\p{M}/gu, "");
  const words = Array.from(normalized.matchAll(/[\p{L}\p{N}]+/gu), (match) => ({
    text: match[0],
    token: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  return { normalized, words };
}

/** Lowercase letters/digits words with accents removed: "Thorin's" → ["thorin", "s"]. */
export function nameTokens(value: string): string[] {
  return nameWords(value).words.map((word) => word.token);
}

/** Whether a single word can stand for a whole name (titles and function words cannot). */
export function isUsableHandle(word: string): boolean {
  const tokens = nameTokens(word);
  if (tokens.length === 0) return false;
  const joined = tokens.join("");
  return joined.length >= 2 && !/^\p{N}+$/u.test(joined) && !NOT_HANDLES.has(tokens[0]);
}

/** Whether a lowercase token is an everyday word that is also a plausible name ("will", "bard"). */
export function isCommonWordName(token: string): boolean {
  return COMMON_WORD_NAMES.has(token);
}

/**
 * Whether a name's tokens read as ordinary prose — every word a common-word
 * name or a title/function word: "will", "the bard", but not "will turner".
 */
export function isCommonWordPhrase(tokens: readonly string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => COMMON_WORD_NAMES.has(token) || NOT_HANDLES.has(token));
}

/**
 * The first word of a multi-word name that can stand for it ("Thorin" for
 * "Thorin Oakenshield", "Gareth" for "Sir Gareth"), or null for a one-word
 * name or one with no usable word.
 */
export function nameHandle(name: string): string | null {
  const words = name.slice(0, MAX_NAME_LENGTH).trim().split(/\s+/);
  if (words.length < 2) return null;
  return words.find(isUsableHandle) ?? null;
}

/**
 * "Thorin (Thorin Oakenshield) — Dwarf Fighter 5; AC 18; HP 12/40; …", leading
 * with the short handle when the name has one so first-name references map
 * reliably. Every field is length-capped and whitespace-flattened.
 */
export function describeCharacter(character: Character): string {
  const short = (value: string) => clip(value, MAX_SHORT_FIELD_LENGTH);
  const name = short(character.name.slice(0, MAX_NAME_LENGTH));
  const handle = nameHandle(character.name);
  const label = handle ? `${short(handle)} (${name})` : name;
  const identity = [character.race && short(character.race), short(character.className), character.level]
    .filter(Boolean)
    .join(" ");
  const { current, max, temporary } = character.hitPoints;
  const parts = [
    `AC ${character.armorClass}`,
    `HP ${current}/${max}${temporary > 0 ? ` (+${temporary} temp)` : ""}`,
  ];
  if (character.passivePerception !== undefined) {
    parts.push(`passive Perception ${character.passivePerception}`);
  }
  if (character.conditions.length > 0) parts.push(`conditions: ${character.conditions.join(", ")}`);
  if (character.notes?.trim()) parts.push(`notes: ${clip(character.notes, MAX_NOTE_LENGTH)}`);
  return `${label} — ${identity}; ${parts.join("; ")}`;
}
