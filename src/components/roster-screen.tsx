"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { CharacterForm } from "@/components/character-form";
import { formatLabel } from "@/lib/character-form-values";
import {
  repository as defaultRepository,
  type AppRepository,
  type Character,
  type PartyScopedRepository,
} from "@/lib/db";
import { useActiveProfile } from "@/lib/profiles/active-profile";
import { useWriteQueue } from "@/lib/use-write-queue";

type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; character: Character };

export type RosterScreenProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: AppRepository;
};

/**
 * The active party's characters. Switching parties remounts the roster, so
 * nothing (an open editor, a pending delete) carries over between parties.
 */
export function RosterScreen({ repo = defaultRepository }: RosterScreenProps) {
  const active = useActiveProfile(repo);
  if (!active.scope) {
    return (
      <section className="roster" aria-labelledby="roster-title">
        <div className="roster__header">
          <h2 id="roster-title">Characters</h2>
        </div>
        {active.error ? (
          <p className="roster__error" role="alert">
            {active.error}
          </p>
        ) : (
          <p className="roster__loading" role="status">
            Loading characters…
          </p>
        )}
      </section>
    );
  }
  return <PartyRoster key={active.scope.partyProfileId} scope={active.scope} />;
}

/*
 * The roster is always re-read from the repository after a create, edit, or
 * delete, so what's shown matches what's persisted in IndexedDB. HP nudges
 * swap in the record returned by the update instead of re-reading everything.
 *
 * Writes for a character are serialized through a per-id queue, and each HP
 * nudge reads the stored record before computing the new value, so rapid or
 * interleaved clicks apply cumulatively instead of racing on a stale render
 * snapshot (see useWriteQueue). While a character has work queued, its row
 * controls are disabled.
 */
function PartyRoster({ scope: repo }: { scope: PartyScopedRepository }) {
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const { enqueue, isPending } = useWriteQueue();
  const addButtonRef = useRef<HTMLButtonElement>(null);

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

  const handleDelete = (character: Character) =>
    enqueue(character.id, async () => {
      setActionError(null);
      try {
        await repo.characters.delete(character.id);
        await load();
        setPendingDeleteId(null);
        // The row (and its focused confirm button) is gone; land somewhere stable.
        addButtonRef.current?.focus();
      } catch (error) {
        setActionError(errorMessage(error, `Could not delete ${character.name}.`));
      }
    });

  const adjustHp = (character: Character, delta: number) =>
    enqueue(character.id, async () => {
      setActionError(null);
      try {
        // Start from the stored value, not the (possibly stale) render snapshot.
        const latest = await repo.characters.getById(character.id);
        if (!latest) {
          await load();
          return;
        }
        const { hitPoints } = latest;
        const current = Math.min(
          hitPoints.max,
          Math.max(0, hitPoints.current + delta),
        );
        const updated =
          current === hitPoints.current
            ? latest
            : await repo.characters.update(character.id, {
                hitPoints: { ...hitPoints, current },
              });
        setCharacters((list) =>
          list?.map((c) => (c.id === updated.id ? updated : c)) ?? list,
        );
      } catch (error) {
        setActionError(
          errorMessage(error, `Could not update HP for ${character.name}.`),
        );
      }
    });

  if (view.kind !== "list") {
    const editing = view.kind === "edit" ? view.character : undefined;
    return (
      <section className="roster-editor" aria-labelledby="roster-editor-title">
        <h2 id="roster-editor-title">
          {editing ? `Edit ${editing.name}` : "Add character"}
        </h2>
        <CharacterForm
          key={editing?.id ?? "new"}
          scope={repo}
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
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setView({ kind: "create" })}
        >
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
          <p>No heroes in this party yet — scan a sheet or add one to keep their stats at hand.</p>
          <Link href="/scan" className="roster__empty-scan">
            Scan a character sheet
          </Link>
        </div>
      ) : (
        <ul className="roster__list">
          {characters.map((character) => (
            <RosterRow
              key={character.id}
              character={character}
              busy={isPending(character.id)}
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
  const deleteRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Move focus into the confirmation so keyboard/screen-reader users land on
  // it, and back to the Delete button if the confirmation is cancelled.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus();
    else if (wasConfirming.current) deleteRef.current?.focus();
    wasConfirming.current = confirmingDelete;
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
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              aria-label={`Edit ${name}`}
            >
              Edit
            </button>
            <button
              ref={deleteRef}
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
