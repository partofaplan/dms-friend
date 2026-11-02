"use client";

import { useEffect, useId, useRef } from "react";

import {
  ABILITIES,
  ABILITY_ABBREVIATIONS,
  formatAbilityScore,
  formatBonus,
  formatSpeed,
  type MonsterBonus,
  type MonsterFeature,
  type MonsterStatBlock as MonsterStatBlockData,
} from "@/lib/monsters/types";

export type MonsterStatBlockProps = {
  monster: MonsterStatBlockData;
  /** Move focus to the monster's name when it renders (after a user selection). */
  focusOnMount?: boolean;
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatBonuses(list: MonsterBonus[]): string {
  return list.map(({ name, bonus }) => `${name} ${formatBonus(bonus)}`).join(", ");
}

/** "Large dragon (chromatic), lawful evil" — skips whatever is missing. */
function describe(monster: MonsterStatBlockData): string {
  const kind = [monster.size, monster.type].filter(Boolean).join(" ");
  const withSubtype = monster.subtype ? `${kind} (${monster.subtype})` : kind;
  return capitalize([withSubtype, monster.alignment].filter(Boolean).join(", "));
}

function withDetail(value: number | null, detail: string): string {
  if (value === null) return detail;
  return detail ? `${value} (${detail})` : String(value);
}

function Property({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="stat-block__property">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FeatureSection({
  title,
  intro,
  features,
}: {
  title: string;
  intro?: string;
  features: MonsterFeature[];
}) {
  const headingId = useId();
  if (features.length === 0 && !intro) return null;
  return (
    <section className="stat-block__section" aria-labelledby={headingId}>
      <h3 id={headingId} className="stat-block__section-title">
        {title}
      </h3>
      {intro && <p className="stat-block__section-intro">{intro}</p>}
      {features.map((feature, index) => {
        // Open5e separates paragraphs (and list items) with newlines.
        const [first = "", ...rest] = feature.desc.split(/\n+/).filter((line) => line.trim());
        return (
          <div key={`${feature.name}-${index}`} className="stat-block__feature">
            <p>
              {feature.name && <strong className="stat-block__feature-name">{feature.name}. </strong>}
              {first}
            </p>
            {rest.map((line, lineIndex) => (
              <p key={lineIndex}>{line}</p>
            ))}
          </div>
        );
      })}
    </section>
  );
}

/** Combat-focused 5e stat block. Sections without content are omitted. */
export function MonsterStatBlock({ monster, focusOnMount = false }: MonsterStatBlockProps) {
  const headingId = useId();
  const abilitiesId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
  }, [focusOnMount, monster.slug]);

  const meta = describe(monster);
  const challenge = monster.challengeRating ?? "";

  return (
    <article className="stat-block" aria-labelledby={headingId}>
      <header className="stat-block__header">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="stat-block__name">
          {monster.name}
        </h2>
        {meta && <p className="stat-block__meta">{meta}</p>}
      </header>

      <dl className="stat-block__properties stat-block__properties--core">
        <Property label="Armor Class" value={withDetail(monster.armorClass, monster.armorDesc)} />
        <Property label="Hit Points" value={withDetail(monster.hitPoints, monster.hitDice)} />
        <Property label="Speed" value={formatSpeed(monster.speed, monster.hover)} />
      </dl>

      <section className="stat-block__abilities" aria-labelledby={abilitiesId}>
        <h3 id={abilitiesId} className="stat-block__section-title">
          Ability Scores
        </h3>
        <dl className="stat-block__ability-list">
          {ABILITIES.map((ability) => {
            const score = monster.abilities[ability];
            return (
              <div key={ability} className="stat-block__ability">
                <dt>
                  <abbr title={capitalize(ability)}>{ABILITY_ABBREVIATIONS[ability]}</abbr>
                </dt>
                <dd>{score === null ? "—" : formatAbilityScore(score)}</dd>
              </div>
            );
          })}
        </dl>
      </section>

      <dl className="stat-block__properties stat-block__properties--details">
        <Property label="Saving Throws" value={formatBonuses(monster.savingThrows)} />
        <Property label="Skills" value={formatBonuses(monster.skills)} />
        <Property label="Damage Vulnerabilities" value={monster.damageVulnerabilities} />
        <Property label="Damage Resistances" value={monster.damageResistances} />
        <Property label="Damage Immunities" value={monster.damageImmunities} />
        <Property label="Condition Immunities" value={monster.conditionImmunities} />
        <Property label="Senses" value={monster.senses} />
        <Property label="Languages" value={monster.languages} />
        <Property label="Challenge" value={challenge} />
      </dl>

      <FeatureSection title="Traits" features={monster.specialAbilities} />
      <FeatureSection title="Actions" features={monster.actions} />
      <FeatureSection title="Bonus Actions" features={monster.bonusActions} />
      <FeatureSection title="Reactions" features={monster.reactions} />
      <FeatureSection
        title="Legendary Actions"
        intro={monster.legendaryActions.length > 0 ? monster.legendaryDesc : undefined}
        features={monster.legendaryActions}
      />
    </article>
  );
}
