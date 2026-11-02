import { describeCombatant, summarizeCombatant } from "@/lib/combat/state";
import { combatantName, type Character, type Combatant } from "@/lib/db/schema";

import { describeCharacter } from "./describe";

/*
 * Explicit @mention tagging for the chat. The DM tags party members and
 * stable combatants by picking them from an autocomplete; only tagged
 * entities are pinned (with their stats) into that turn's system prompt.
 * Nothing is inferred from untagged prose. Pure functions.
 *
 * Model: the draft stays plain, readable text with "@<token>" tags in it
 * ("how hurt is @Thorin Oakenshield?"). Every mentionable has a token that is
 * unique among the current party and stable (a repeated name gets a " (2)",
 * " (3)" suffix), and each autocomplete pick records { id, token } for the
 * draft. On send, every "@" in the text is matched against the picked tokens
 * (authoritative: they hold the id the DM chose, even if the stable has since
 * renumbered) and then the current tokens, longest match first. A tag whose
 * text was edited away, or whose entity is gone, pins nothing.
 */

/** Suggestions shown in the autocomplete. */
export const MAX_MENTION_OPTIONS = 8;
/** Entities pinned for one message, in the order the message first tags them. */
export const MAX_PINNED_MENTIONS = 6;
/** Characters kept of a name when it becomes a mention token. */
export const MAX_MENTION_TOKEN_LENGTH = 60;
/** Characters after "@" still treated as an autocomplete query. */
export const MAX_MENTION_QUERY_LENGTH = 60;

export type MentionKind = "character" | "combatant";

/** A party member or combatant the DM can @mention. */
export interface Mentionable {
  kind: MentionKind;
  id: string;
  /** The character's name or the combatant's label/monster name. */
  name: string;
  /** What follows "@" when inserted; unique (case-insensitively) among mentionables. */
  token: string;
  /** Short distinguishing detail for the autocomplete: "PC · Fighter 5 · HP 9/44". */
  hint: string;
  /** Compact stat line pinned into the prompt (the party/combat summaries' line). */
  summary: string;
  /** Extra text the autocomplete matches on (a combatant's monster name). */
  aliases: string[];
}

/** An autocomplete pick recorded for the current draft. */
export interface ChosenMention {
  id: string;
  token: string;
}

/** A tagged entity pinned into the system prompt's "Referenced now" block. */
export interface PinnedReference {
  kind: MentionKind;
  id: string;
  name: string;
  /** The entity's current mention token (distinguishes same-named entities). */
  token: string;
  summary: string;
}

/** The "@query" the caret is in: "@" at `start`, the word running to `end`. */
export interface ActiveMention {
  start: number;
  end: number;
  /** Text between "@" and the caret. */
  query: string;
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** Lowercase with accents removed, for matching. */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function tokenFor(name: string, fallback: string): string {
  const flat = name.replace(/\s+/g, " ").trim().slice(0, MAX_MENTION_TOKEN_LENGTH).trimEnd();
  return flat || fallback;
}

/**
 * Every party member then every combatant, each with a unique mention token.
 * Two "Goblin"s become "Goblin" and "Goblin (2)", so a tag means one entity.
 */
export function buildMentionables(
  party: readonly Character[],
  combatants: readonly Combatant[],
): Mentionable[] {
  const base: Omit<Mentionable, "token">[] = [
    ...party.map((character) => {
      const level = [character.className, character.level].filter(Boolean).join(" ");
      const { current, max } = character.hitPoints;
      return {
        kind: "character" as const,
        id: character.id,
        name: character.name,
        hint: ["PC", level, `HP ${current}/${max}`].filter(Boolean).join(" · "),
        summary: describeCharacter(character),
        aliases: [],
      };
    }),
    ...combatants.map((combatant) => {
      const summary = summarizeCombatant(combatant);
      const { current, max } = summary.hitPoints;
      return {
        kind: "combatant" as const,
        id: combatant.id,
        name: combatantName(combatant),
        hint: [
          summary.challengeRating && `CR ${summary.challengeRating}`,
          `HP ${current}/${max}${summary.down ? " (down)" : ""}`,
        ]
          .filter(Boolean)
          .join(" · "),
        summary: describeCombatant(summary),
        aliases: [combatant.monster.name],
      };
    }),
  ];

  const taken = new Set<string>();
  return base.map((entry) => {
    const root = tokenFor(entry.name, entry.kind === "character" ? "Character" : "Monster");
    let token = root;
    for (let n = 2; taken.has(fold(token)); n++) token = `${root} (${n})`;
    taken.add(fold(token));
    return { ...entry, token };
  });
}

/**
 * The "@word" the caret is in or just after, or null. "@" must start the
 * text or follow a non-word character (so "dm@example.com" is not a tag),
 * and the query runs from "@" to the caret without whitespace.
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_MENTION_QUERY_LENGTH + 1; i--) {
    const char = text[i];
    if (/\s/.test(char)) return null;
    if (char !== "@") continue;
    if (isWordChar(text[i - 1])) return null;
    let end = caret;
    while (end < text.length && !/\s/.test(text[end])) end++;
    return { start: i, end, query: text.slice(i + 1, caret) };
  }
  return null;
}

/**
 * Autocomplete suggestions for a query: names (or tokens) starting with it,
 * then names with a word starting with it ("oak" → "Thorin Oakenshield", or a
 * combatant's monster name), then names containing it. Case- and
 * accent-insensitive; at most `limit`, in roster order within each rank.
 */
export function filterMentionables(
  mentionables: readonly Mentionable[],
  query: string,
  limit = MAX_MENTION_OPTIONS,
): Mentionable[] {
  const q = fold(query.trim());
  const rank = (m: Mentionable): number => {
    if (!q) return 0;
    const fields = [m.name, m.token].map(fold);
    if (fields.some((field) => field.startsWith(q))) return 0;
    const words = [m.name, ...m.aliases].flatMap((value) => fold(value).split(/[^\p{L}\p{N}]+/u));
    if (words.some((word) => word.startsWith(q))) return 1;
    if ([...fields, ...m.aliases.map(fold)].some((field) => field.includes(q))) return 2;
    return -1;
  };
  return mentionables
    .map((m, index) => ({ m, index, rank: rank(m) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.m);
}

/**
 * Replace the active "@query" with "@<token> " and return the new text, the
 * caret after it, and the pick to record for the draft.
 */
export function insertMention(
  text: string,
  active: ActiveMention,
  mentionable: Mentionable,
): { text: string; caret: number; chosen: ChosenMention } {
  const after = text.slice(active.end);
  const tag = `@${mentionable.token}${/^\s/.test(after) ? "" : " "}`;
  return {
    text: `${text.slice(0, active.start)}${tag}${after}`,
    caret: active.start + tag.length + (/^\s/.test(after) ? 1 : 0),
    chosen: { id: mentionable.id, token: mentionable.token },
  };
}

type Candidate = { folded: string; target: Mentionable };

/** Picked tokens (for entities that still exist), then current ones; longest first. */
function tagCandidates(chosen: readonly ChosenMention[], mentionables: readonly Mentionable[]): Candidate[] {
  const byId = new Map(mentionables.map((m) => [m.id, m]));
  return [
    ...chosen.flatMap((pick) => {
      const target = byId.get(pick.id);
      return target ? [{ token: pick.token, target }] : [];
    }),
    ...mentionables.map((m) => ({ token: m.token, target: m })),
  ]
    .map((candidate, order) => ({ folded: candidate.token.toLowerCase(), target: candidate.target, order }))
    .filter((candidate) => candidate.folded.length > 0)
    .sort((a, b) => b.folded.length - a.folded.length || a.order - b.order);
}

/** The entity the "@" at `at` tags, or undefined. */
function tagAt(text: string, at: number, candidates: readonly Candidate[]): Mentionable | undefined {
  if (text[at] !== "@" || isWordChar(text[at - 1])) return undefined;
  return candidates.find(
    ({ folded }) =>
      text.slice(at + 1, at + 1 + folded.length).toLowerCase() === folded &&
      !isWordChar(text[at + 1 + folded.length]),
  )?.target;
}

/**
 * The entities `text` tags, in the order first tagged, at most
 * MAX_PINNED_MENTIONS. At each "@", the longest token that matches (case-
 * insensitively, ending at a word boundary) wins; a picked token beats a
 * current one of the same length. Picks whose entity no longer exists, and
 * tags matching no token, are dropped.
 */
export function pinMentions(
  text: string,
  chosen: readonly ChosenMention[],
  mentionables: readonly Mentionable[],
): PinnedReference[] {
  const candidates = tagCandidates(chosen, mentionables);
  const pinned: PinnedReference[] = [];
  const seen = new Set<string>();
  for (let i = text.indexOf("@"); i >= 0 && pinned.length < MAX_PINNED_MENTIONS; i = text.indexOf("@", i + 1)) {
    const target = tagAt(text, i, candidates);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    const { kind, id, name, token, summary } = target;
    pinned.push({ kind, id, name, token, summary });
  }
  return pinned;
}

/** `text` with every tag of `id` turned back into plain words ("@Thorin" → "Thorin"). */
export function untagMention(
  text: string,
  id: string,
  chosen: readonly ChosenMention[],
  mentionables: readonly Mentionable[],
): string {
  const candidates = tagCandidates(chosen, mentionables);
  let result = text;
  for (let i = result.indexOf("@"); i >= 0; i = result.indexOf("@", i)) {
    if (tagAt(result, i, candidates)?.id === id) {
      result = `${result.slice(0, i)}${result.slice(i + 1)}`;
    } else {
      i++;
    }
  }
  return result;
}
