"use client";

import Link from "next/link";
import { useState } from "react";

import { combatantName, repository as defaultRepository, type Repository } from "@/lib/db";
import type { MonsterStatBlock } from "@/lib/monsters/types";

export type AddToStableProps = {
  monster: MonsterStatBlock;
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: Repository;
};

type AddState =
  | { status: "idle" }
  | { status: "adding" }
  | { status: "added"; name: string }
  | { status: "error"; message: string };

/*
 * Saves the viewed stat block to the monster stable at full HP. Adding again
 * is allowed (a second goblin) and gets the next number ("Goblin 2"). Works
 * offline: the stat block is already loaded and the stable is local.
 *
 * Render with key={monster.slug} so the feedback resets per monster.
 */
export function AddToStable({ monster, repo = defaultRepository }: AddToStableProps) {
  const [state, setState] = useState<AddState>({ status: "idle" });

  async function add() {
    setState({ status: "adding" });
    try {
      const combatant = await repo.combatants.addFromMonster(monster);
      setState({ status: "added", name: combatantName(combatant) });
    } catch {
      setState({
        status: "error",
        message:
          monster.hitPoints === null
            ? `${monster.name} has no hit points listed, so it can't be tracked.`
            : `Could not add ${monster.name} to the stable.`,
      });
    }
  }

  return (
    <div className="add-to-stable">
      <button
        type="button"
        className="add-to-stable__button"
        onClick={() => void add()}
        disabled={state.status === "adding"}
      >
        Add to stable
      </button>
      <p role="status" aria-live="polite" className="add-to-stable__status">
        {state.status === "added" && (
          <>
            Added {state.name} to the stable.{" "}
            <Link href="/stable" className="add-to-stable__link">
              Open stable
            </Link>
          </>
        )}
      </p>
      {state.status === "error" && (
        <p role="alert" className="add-to-stable__error">
          {state.message}
        </p>
      )}
    </div>
  );
}
