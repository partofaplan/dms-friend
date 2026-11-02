"use client";

import Link from "next/link";
import { useEffect, useId, useState, type ChangeEvent } from "react";

import { PROFILES_NAV_ITEM } from "@/components/nav-items";
import { repository as defaultRepository, type AppRepository, type PartyProfile } from "@/lib/db";
import { setActiveParty, useActiveProfile } from "@/lib/profiles/active-profile";

export type ActiveScopeBarProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: AppRepository;
};

/*
 * Persistent strip at the top of every screen: who's playing and which party
 * every screen is scoped to, a switcher for the active user's parties, and
 * the way into /profiles. Mounted once in the root layout; resolving the
 * active profile here also guarantees one exists from the first screen on.
 */
export function ActiveScopeBar({ repo = defaultRepository }: ActiveScopeBarProps) {
  const active = useActiveProfile(repo);
  const selectId = useId();
  const [parties, setParties] = useState<PartyProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const userId = active.user?.id ?? null;

  // Re-read on every (re)resolution, so renames and new parties show up.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    repo.partyProfiles.listByUser(userId).then(
      (all) => {
        if (!cancelled) setParties(all);
      },
      () => {
        if (!cancelled) setParties([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repo, userId, active.partyProfile]);

  async function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value;
    setError(null);
    try {
      await setActiveParty(id, repo);
    } catch {
      setError("Could not switch parties.");
    }
  }

  return (
    <section className="active-scope" aria-label="Active profile">
      {active.status === "ready" ? (
        <>
          <p className="active-scope__summary">
            <span className="active-scope__user">User: {active.user.name}</span>
            <span className="active-scope__separator" aria-hidden="true">
              {" · "}
            </span>
            <span className="active-scope__party">Party: {active.partyProfile.name}</span>
          </p>
          <div className="active-scope__switcher">
            <label htmlFor={selectId} className="active-scope__label">
              Active party
            </label>
            <select
              id={selectId}
              className="active-scope__select"
              value={active.partyProfile.id}
              onChange={(event) => void handleChange(event)}
            >
              {/* Until the list loads, the active party alone keeps the value valid. */}
              {(parties.some((p) => p.id === active.partyProfile.id) ? parties : [active.partyProfile]).map(
                (party) => (
                  <option key={party.id} value={party.id}>
                    {party.name}
                  </option>
                ),
              )}
            </select>
          </div>
        </>
      ) : (
        <p className="active-scope__summary" role={active.error ? "alert" : undefined}>
          {active.error ?? "Loading profile…"}
        </p>
      )}
      {error && (
        <p className="active-scope__error" role="alert">
          {error}
        </p>
      )}
      <Link href={PROFILES_NAV_ITEM.href} className="active-scope__manage">
        {PROFILES_NAV_ITEM.label}
      </Link>
    </section>
  );
}
