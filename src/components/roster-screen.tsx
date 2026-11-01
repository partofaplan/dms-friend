"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CharacterForm } from "@/components/character-form";
import { formatLabel } from "@/lib/character-form-values";
import {
  repository as defaultRepository,
  type Character,
  type Repository,
} from "@/lib/db";

type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; character: Character };

export type RosterScreenProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: Repository;
};

/*
 * The roster is always re-read from the repository after a create, edit, or
 * delete, so what's shown matches what's persisted in IndexedDB. HP nudges
 * swap in the record returned by the update instead of re-reading everything.
 */
export function RosterScreen({ repo = defaultRepository }: RosterScreenProps) {
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await repo.characters.getAll();
      setCharacters(all);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load characters."));
    }
  }, [repo]);

  useEffect(() => {
    let active = true;
    repo.characters.getAll().then(
      (all) => {
        if (active) setCharacters(all);
      },
      (error: unknown) => {
        if (active) setLoadError(errorMessage(error, "Could not load characters."));
      },
    );
    return () => {
      active = false;
    };
  }, [repo]);

  const handleSaved = async () => {
    setView({ kind: "list" });
    await load();
  };

  const handleDelete = async (character: Character) => {
    setBusyId(character.id);
    setActionError(null);
    try {
      await repo.characters.delete(character.id);
      setPendingDeleteId(null);
      await load();
    } catch (error) {
      setActionError(errorMessage(error, `Could not delete ${character.name}.`));
    } finally {
      setBusyId(null);
    }
  };

  const adjustHp = async (character: Character, delta: number) => {
    const { hitPoints } = character;
    const current = Math.min(
      hitPoints.max,
      Math.max(0, hitPoints.current + delta),
    );
    if (current === hitPoints.current) return;
    setBusyId(character.id);
    setActionError(null);
    try {
      const updated = await repo.characters.update(character.id, {
        hitPoints: { ...hitPoints, current },
      });
      setCharacters((list) =>
        list?.map((c) => (c.id === updated.id ? updated : c)) ?? list,
      );
    } catch (error) {
      setActionError(
        errorMessage(error, `Could not update HP for ${character.name}.`),
      );
    } finally {
      setBusyId(null);
    }
  };

  if (view.kind !== "list") {
    const editing = view.kind === "edit" ? view.character : undefined;
    return (
      <section className="roster-editor" aria-labelledby="roster-editor-title">
        <h2 id="roster-editor-title">
          {editing ? `Edit ${editing.name}` : "Add character"}
        </h2>
        <CharacterForm
          key={editing?.id ?? "new"}
          repo={repo}
          characterId={editing?.id}
          initialValues={editing}
          onSaved={handleSaved}
          onCancel={() => setView({ kind: "list" })}
        />
      </section>
    );
  }

  return (
    <section className="roster" aria-labelledby="roster-title">
      <div className="roster__header">
        <h2 id="roster-title">Characters</h2>
        <button type="button" onClick={() => setView({ kind: "create" })}>
          Add character
        </button>
      </div>

      {loadError && (
        <p className="roster__error" role="alert">
          {loadError}
        </p>
      )}
      {actionError && (
        <p className="roster__error" role="alert">
          {actionError}
        </p>
      )}

      {characters === null ? (
        !loadError && (
          <p className="roster__loading" role="status">
            Loading characters…
          </p>
        )
      ) : characters.length === 0 ? (
        <div className="roster__empty">
          <p>No characters yet.</p>
          <p>Add your party&apos;s characters to keep their stats at hand.</p>
        </div>
      ) : (
        <ul className="roster__list">
          {characters.map((character) => (
            <RosterRow
              key={character.id}
              character={character}
              busy={busyId === character.id}
              confirmingDelete={pendingDeleteId === character.id}
              onEdit={() => setView({ kind: "edit", character })}
              onRequestDelete={() => setPendingDeleteId(character.id)}
              onCancelDelete={() => setPendingDeleteId(null)}
              onConfirmDelete={() => handleDelete(character)}
              onAdjustHp={(delta) => adjustHp(character, delta)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type RosterRowProps = {
  character: Character;
  busy: boolean;
  confirmingDelete: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onAdjustHp: (delta: number) => void;
};

function RosterRow({
  character,
  busy,
  confirmingDelete,
  onEdit,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onAdjustHp,
}: RosterRowProps) {
  const { name, race, className, level, armorClass, hitPoints, conditions } =
    character;
  const headingId = `character-${character.id}-name`;
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus into the confirmation so keyboard/screen-reader users land on it.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus();
  }, [confirmingDelete]);

  return (
    <li className="roster-row">
      <article aria-labelledby={headingId}>
        <h3 id={headingId} className="roster-row__name">
          {name}
        </h3>
        <p className="roster-row__summary">
          {[race, `${className} ${level}`].filter(Boolean).join(" · ")}
        </p>
        <dl className="roster-row__stats">
          <div className="roster-row__stat">
            <dt>AC</dt>
            <dd>{armorClass}</dd>
          </div>
          <div className="roster-row__stat">
            <dt>HP</dt>
            <dd>
              {hitPoints.current} / {hitPoints.max}
              {hitPoints.temporary > 0 && ` (+${hitPoints.temporary} temp)`}
            </dd>
          </div>
        </dl>
        {conditions.length > 0 && (
          <p className="roster-row__conditions">
            Conditions: {conditions.map(formatLabel).join(", ")}
          </p>
        )}

        <div className="roster-row__hp-controls" role="group" aria-label={`Adjust HP for ${name}`}>
          <button
            type="button"
            onClick={() => onAdjustHp(-1)}
            disabled={busy || hitPoints.current <= 0}
            aria-label={`Decrease HP for ${name}`}
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onAdjustHp(1)}
            disabled={busy || hitPoints.current >= hitPoints.max}
            aria-label={`Increase HP for ${name}`}
          >
            +
          </button>
        </div>

        {confirmingDelete ? (
          <div
            className="roster-row__confirm"
            role="group"
            aria-label={`Confirm deleting ${name}`}
          >
            <p>Delete {name}? This cannot be undone.</p>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirmDelete}
              disabled={busy}
            >
              Confirm delete
            </button>
            <button type="button" onClick={onCancelDelete} disabled={busy}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="roster-row__actions">
            <button type="button" onClick={onEdit} aria-label={`Edit ${name}`}>
              Edit
            </button>
            <button
              type="button"
              onClick={onRequestDelete}
              aria-label={`Delete ${name}`}
            >
              Delete
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
