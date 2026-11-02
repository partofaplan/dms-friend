"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { formatLabel } from "@/lib/character-form-values";
import {
  CONDITIONS,
  combatantName,
  repository as defaultRepository,
  type Combatant,
  type CombatantUpdate,
  type Condition,
  type AppRepository,
  type PartyScopedRepository,
} from "@/lib/db";
import { useActiveProfile } from "@/lib/profiles/active-profile";
import { useWriteQueue } from "@/lib/use-write-queue";

export type StableScreenProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: AppRepository;
};

/**
 * The active party's monster stable. Switching parties remounts it, so no
 * pending delete or edit carries over between parties.
 */
export function StableScreen({ repo = defaultRepository }: StableScreenProps) {
  const active = useActiveProfile(repo);
  if (!active.scope) {
    return (
      <section className="stable" aria-labelledby="stable-title">
        <div className="stable__header">
          <h2 id="stable-title">Monsters in combat</h2>
        </div>
        {active.error ? (
          <p className="stable__error" role="alert">
            {active.error}
          </p>
        ) : (
          <p className="stable__loading" role="status">
            Loading the stable…
          </p>
        )}
      </section>
    );
  }
  return <PartyStable key={active.scope.partyProfileId} scope={active.scope} />;
}

/** Computes a change from the stored record; null means nothing to write. */
type Change = (latest: Combatant) => CombatantUpdate | null;

/*
 * Combat tracker for the monster stable, mirroring the roster's concurrency
 * model: every write for a combatant is serialized through a per-id queue, and
 * each one reads the stored record before computing its change, so rapid or
 * interleaved clicks apply cumulatively instead of racing on a stale render
 * snapshot. While a combatant has work queued, its row controls are disabled.
 * Updates swap in the returned record; a delete (or a vanished record)
 * re-reads the whole stable.
 */
function PartyStable({ scope: repo }: { scope: PartyScopedRepository }) {
  const [combatants, setCombatants] = useState<Combatant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const { enqueue, isPending } = useWriteQueue();
  const findLinkRef = useRef<HTMLAnchorElement>(null);

  const load = useCallback(async () => {
    try {
      setCombatants(await repo.combatants.getAll());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load the stable."));
    }
  }, [repo]);

  useEffect(() => {
    let active = true;
    repo.combatants.getAll().then(
      (all) => {
        if (active) setCombatants(all);
      },
      (error: unknown) => {
        if (active) setLoadError(errorMessage(error, "Could not load the stable."));
      },
    );
    return () => {
      active = false;
    };
  }, [repo]);

  const mutate = (combatant: Combatant, change: Change) =>
    enqueue(combatant.id, async () => {
      setActionError(null);
      try {
        // Start from the stored value, not the (possibly stale) render snapshot.
        const latest = await repo.combatants.getById(combatant.id);
        if (!latest) {
          await load();
          return;
        }
        const changes = change(latest);
        const updated = changes
          ? await repo.combatants.update(combatant.id, changes)
          : latest;
        setCombatants(
          (list) => list?.map((c) => (c.id === updated.id ? updated : c)) ?? list,
        );
      } catch (error) {
        setActionError(
          errorMessage(error, `Could not update ${combatantName(combatant)}.`),
        );
      }
    });

  const handleDelete = (combatant: Combatant) =>
    enqueue(combatant.id, async () => {
      setActionError(null);
      try {
        await repo.combatants.delete(combatant.id);
        await load();
        setPendingDeleteId(null);
        // The row (and its focused confirm button) is gone; land somewhere stable.
        findLinkRef.current?.focus();
      } catch (error) {
        setActionError(
          errorMessage(error, `Could not remove ${combatantName(combatant)}.`),
        );
      }
    });

  return (
    <section className="stable" aria-labelledby="stable-title">
      <div className="stable__header">
        <h2 id="stable-title">Monsters in combat</h2>
        <Link ref={findLinkRef} href="/monsters" className="stable__find">
          Find monsters
        </Link>
      </div>

      {loadError && (
        <p className="stable__error" role="alert">
          {loadError}
        </p>
      )}
      {actionError && (
        <p className="stable__error" role="alert">
          {actionError}
        </p>
      )}

      {combatants === null ? (
        !loadError && (
          <p className="stable__loading" role="status">
            Loading the stable…
          </p>
        )
      ) : combatants.length === 0 ? (
        <div className="stable__empty">
          <p>No monsters in the stable.</p>
          <p>Look up a monster and choose “Add to stable” to track it in combat.</p>
        </div>
      ) : (
        <ul className="stable__list">
          {combatants.map((combatant) => (
            <StableRow
              key={combatant.id}
              combatant={combatant}
              busy={isPending(combatant.id)}
              confirmingDelete={pendingDeleteId === combatant.id}
              onChange={(change) => mutate(combatant, change)}
              onRequestDelete={() => setPendingDeleteId(combatant.id)}
              onCancelDelete={() => setPendingDeleteId(null)}
              onConfirmDelete={() => handleDelete(combatant)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Changes (pure; applied to the stored record) ─────────────────────────── */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Nudges current HP within 0..max; temporary HP is left alone, as in the roster. */
const adjustHp =
  (delta: number): Change =>
  ({ hitPoints }) => {
    const current = clamp(hitPoints.current + delta, 0, hitPoints.max);
    return current === hitPoints.current ? null : { hitPoints: { ...hitPoints, current } };
  };

const setHp =
  (value: number): Change =>
  ({ hitPoints }) => {
    const current = clamp(Math.trunc(value), 0, hitPoints.max);
    return current === hitPoints.current ? null : { hitPoints: { ...hitPoints, current } };
  };

const setTemporaryHp =
  (value: number): Change =>
  ({ hitPoints }) => {
    const temporary = Math.max(0, Math.trunc(value));
    return temporary === hitPoints.temporary ? null : { hitPoints: { ...hitPoints, temporary } };
  };

/** Back to the start of a fight: full HP, no temporary HP. Conditions are kept. */
const resetHp: Change = ({ hitPoints }) =>
  hitPoints.current === hitPoints.max && hitPoints.temporary === 0
    ? null
    : { hitPoints: { ...hitPoints, current: hitPoints.max, temporary: 0 } };

const setCondition =
  (condition: Condition, on: boolean): Change =>
  ({ conditions }) => {
    if (conditions.includes(condition) === on) return null;
    return {
      conditions: on
        ? CONDITIONS.filter((c) => c === condition || conditions.includes(c))
        : conditions.filter((c) => c !== condition),
    };
  };

/** A blank label clears it, so the row falls back to the monster's name. */
const setLabel =
  (value: string): Change =>
  (latest) => {
    const label = value.trim() || undefined;
    return label === latest.label ? null : { label };
  };

/* ── Row ──────────────────────────────────────────────────────────────────── */

type StableRowProps = {
  combatant: Combatant;
  busy: boolean;
  confirmingDelete: boolean;
  onChange: (change: Change) => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
};

/** Reads a number input from a submitted form; null if blank or not a number. */
function numberField(event: FormEvent<HTMLFormElement>, name: string): number | null {
  event.preventDefault();
  const raw = new FormData(event.currentTarget).get(name);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function StableRow({
  combatant,
  busy,
  confirmingDelete,
  onChange,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: StableRowProps) {
  const { id, monster, hitPoints, conditions } = combatant;
  const name = combatantName(combatant);
  const prefix = `combatant-${id}`;
  const headingId = `${prefix}-name`;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Move focus into the confirmation, and back to Remove if it's cancelled.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus();
    else if (wasConfirming.current) removeRef.current?.focus();
    wasConfirming.current = confirmingDelete;
  }, [confirmingDelete]);

  const summary = [
    name !== monster.name && monster.name,
    [monster.size, monster.type].filter(Boolean).join(" "),
    monster.challengeRating && `CR ${monster.challengeRating}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={`stable-row${hitPoints.current === 0 ? " stable-row--down" : ""}`}>
      <article aria-labelledby={headingId}>
        <h3 id={headingId} className="stable-row__name">
          {name}
        </h3>
        {summary && <p className="stable-row__summary">{summary}</p>}
        <dl className="stable-row__stats">
          <div className="stable-row__stat">
            <dt>AC</dt>
            <dd>{monster.armorClass ?? "—"}</dd>
          </div>
          <div className="stable-row__stat">
            <dt>HP</dt>
            <dd>
              <span className="stable-row__hp-current">{hitPoints.current}</span>{" "}
              <span className="stable-row__hp-max">/ {hitPoints.max}</span>
              {hitPoints.temporary > 0 && ` (+${hitPoints.temporary} temp)`}
            </dd>
          </div>
        </dl>
        {conditions.length > 0 && (
          <p className="stable-row__conditions">
            Conditions: {conditions.map(formatLabel).join(", ")}
          </p>
        )}

        <div className="stable-row__hp-controls" role="group" aria-label={`Adjust HP for ${name}`}>
          <button
            type="button"
            onClick={() => onChange(adjustHp(-1))}
            disabled={busy || hitPoints.current <= 0}
            aria-label={`Decrease HP for ${name}`}
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onChange(adjustHp(1))}
            disabled={busy || hitPoints.current >= hitPoints.max}
            aria-label={`Increase HP for ${name}`}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => onChange(resetHp)}
            disabled={busy}
            aria-label={`Reset HP for ${name}`}
          >
            Reset
          </button>
        </div>

        <form
          className="stable-row__field"
          onSubmit={(event) => {
            const value = numberField(event, "current");
            if (value !== null) onChange(setHp(value));
          }}
        >
          <label htmlFor={`${prefix}-current`}>Current HP for {name}</label>
          {/* Keyed on the stored value so the field resyncs after any write. No
              min/max: out-of-range entries are clamped rather than blocked. */}
          <input
            key={hitPoints.current}
            id={`${prefix}-current`}
            name="current"
            type="number"
            inputMode="numeric"
            defaultValue={hitPoints.current}
            disabled={busy}
          />
          <button type="submit" disabled={busy} aria-label={`Set HP for ${name}`}>
            Set
          </button>
        </form>

        <form
          className="stable-row__field"
          onSubmit={(event) => {
            const value = numberField(event, "temporary");
            if (value !== null) onChange(setTemporaryHp(value));
          }}
        >
          <label htmlFor={`${prefix}-temporary`}>Temporary HP for {name}</label>
          <input
            key={hitPoints.temporary}
            id={`${prefix}-temporary`}
            name="temporary"
            type="number"
            inputMode="numeric"
            defaultValue={hitPoints.temporary}
            disabled={busy}
          />
          <button type="submit" disabled={busy} aria-label={`Set temporary HP for ${name}`}>
            Set
          </button>
        </form>

        <form
          className="stable-row__field"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("label");
            onChange(setLabel(typeof value === "string" ? value : ""));
          }}
        >
          <label htmlFor={`${prefix}-label`}>Label for {name}</label>
          <input
            key={combatant.label ?? ""}
            id={`${prefix}-label`}
            name="label"
            type="text"
            autoComplete="off"
            placeholder={monster.name}
            defaultValue={combatant.label ?? ""}
            disabled={busy}
          />
          <button type="submit" disabled={busy} aria-label={`Save label for ${name}`}>
            Save
          </button>
        </form>

        <fieldset className="stable-row__conditions-toggle" disabled={busy}>
          <legend>Conditions for {name}</legend>
          <ul className="stable-row__condition-list">
            {CONDITIONS.map((condition) => (
              <li key={condition} className="stable-row__condition">
                <label>
                  <input
                    type="checkbox"
                    checked={conditions.includes(condition)}
                    onChange={(event) => onChange(setCondition(condition, event.target.checked))}
                  />
                  {formatLabel(condition)}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        {confirmingDelete ? (
          <div
            className="stable-row__confirm"
            role="group"
            aria-label={`Confirm removing ${name}`}
          >
            <p>Remove {name} from the stable?</p>
            <button ref={confirmRef} type="button" onClick={onConfirmDelete} disabled={busy}>
              Confirm remove
            </button>
            <button type="button" onClick={onCancelDelete} disabled={busy}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="stable-row__actions">
            <button
              ref={removeRef}
              type="button"
              onClick={onRequestDelete}
              aria-label={`Remove ${name}`}
            >
              Remove
            </button>
          </div>
        )}
      </article>
    </li>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
