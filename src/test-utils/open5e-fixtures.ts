/*
 * Raw Open5e v1 monster payloads for tests. The goblin mirrors the real SRD
 * entry (including its nulls and empty strings); the guardian is synthetic, a
 * CR 11 that exercises every optional section.
 */

export const goblinRaw = {
  slug: "goblin",
  desc: "",
  name: "Goblin",
  size: "Small",
  type: "humanoid",
  subtype: "goblinoid",
  group: null,
  alignment: "neutral evil",
  armor_class: 15,
  armor_desc: "leather armor, shield",
  hit_points: 7,
  hit_dice: "2d6",
  speed: { walk: 30 },
  strength: 8,
  dexterity: 14,
  constitution: 10,
  intelligence: 10,
  wisdom: 8,
  charisma: 8,
  strength_save: null,
  dexterity_save: null,
  constitution_save: null,
  intelligence_save: null,
  wisdom_save: null,
  charisma_save: null,
  perception: null,
  skills: { stealth: 6 },
  damage_vulnerabilities: "",
  damage_resistances: "",
  damage_immunities: "",
  condition_immunities: "",
  senses: "darkvision 60 ft., passive Perception 9",
  languages: "Common, Goblin",
  challenge_rating: "1/4",
  cr: 0.25,
  actions: [
    {
      name: "Scimitar",
      desc: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.",
    },
    {
      name: "Shortbow",
      desc: "Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage.",
    },
  ],
  bonus_actions: null,
  reactions: null,
  legendary_desc: "",
  legendary_actions: null,
  special_abilities: [
    {
      name: "Nimble Escape",
      desc: "The goblin can take the Disengage or Hide action as a bonus action on each of its turns.",
    },
  ],
  spell_list: [],
  page_no: 315,
  environments: ["Forest"],
  img_main: null,
  document__slug: "wotc-srd",
  document__title: "5e Core Rules",
};

export const guardianRaw = {
  slug: "vault-guardian",
  name: "Vault Guardian",
  size: "Large",
  type: "construct",
  subtype: "",
  alignment: "unaligned",
  armor_class: 18,
  armor_desc: "natural armor",
  hit_points: 178,
  hit_dice: "17d10+85",
  speed: { walk: 40, fly: 60, hover: true },
  strength: 23,
  dexterity: 9,
  constitution: 20,
  intelligence: 3,
  wisdom: 11,
  charisma: 1,
  strength_save: 11,
  dexterity_save: null,
  constitution_save: 10,
  intelligence_save: null,
  wisdom_save: 5,
  charisma_save: null,
  skills: { perception: 5, athletics: 11 },
  damage_vulnerabilities: "thunder",
  damage_resistances: "fire",
  damage_immunities: "poison, psychic",
  condition_immunities: "charmed, exhaustion, poisoned",
  senses: "darkvision 120 ft., passive Perception 15",
  languages: "understands the languages of its creator but can't speak",
  challenge_rating: "11",
  cr: 11,
  actions: [
    { name: "Multiattack", desc: "The guardian makes two slam attacks." },
    {
      name: "Slam",
      desc: "Melee Weapon Attack: +11 to hit, reach 10 ft., one target. Hit: 20 (3d8 + 6) bludgeoning damage.",
    },
  ],
  bonus_actions: [{ name: "Lock Down", desc: "The guardian seals one door it can see." }],
  reactions: [{ name: "Parry", desc: "The guardian adds 3 to its AC against one melee attack." }],
  legendary_desc:
    "The guardian can take 3 legendary actions, choosing from the options below.",
  legendary_actions: [
    { name: "Detect", desc: "The guardian makes a Wisdom (Perception) check." },
    { name: "Slam (Costs 2 Actions)", desc: "The guardian makes one slam attack." },
  ],
  special_abilities: [
    { name: "Immutable Form", desc: "The guardian is immune to any effect that would alter its form." },
  ],
};

export function searchPayload(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}
