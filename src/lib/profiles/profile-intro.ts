import { useEffect, useState } from "react";

import { DEFAULT_USER_NAME, repository as defaultRepository, type AppRepository } from "@/lib/db";
import { useActiveProfile } from "@/lib/profiles/active-profile";

/*
 * The first-run "name your profile" nudge. A fresh install lands in the
 * auto-created "Default User" / "Default Party"; until the user dismisses the
 * nudge or renames away from the default, it suggests naming them. Either
 * outcome is remembered in localStorage so it never comes back. Client only.
 */

export const PROFILE_INTRO_STORAGE_KEY = "dm-friend:has-seen-profile-intro";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined; // Storage can throw when disabled (e.g. privacy settings).
  }
}

export function hasSeenProfileIntro(): boolean {
  try {
    return storage()?.getItem(PROFILE_INTRO_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markProfileIntroSeen(): void {
  try {
    storage()?.setItem(PROFILE_INTRO_STORAGE_KEY, "true");
  } catch {
    // Disabled storage: the nudge may return next launch, which is harmless.
  }
}

export type ProfileIntro =
  | { show: false; userName: null; partyName: null; dismiss: () => void }
  | { show: true; userName: string; partyName: string; dismiss: () => void };

/**
 * Whether to show the nudge: the intro hasn't been seen and the active user
 * is still the untouched default (named "Default User" and the only user).
 * Hidden until that's known, so it never flashes in during hydration.
 */
export function useProfileIntro(repo: AppRepository = defaultRepository): ProfileIntro {
  const active = useActiveProfile(repo);
  // The user whose profile count was checked, and whether they were the only one.
  const [onlyUser, setOnlyUser] = useState<{ userId: string; only: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const user = active.user;
  const isDefault = user?.name === DEFAULT_USER_NAME;

  useEffect(() => {
    if (!user || hasSeenProfileIntro()) return;
    if (!isDefault) {
      // Renamed away from (or never on) the default: done for good.
      markProfileIntroSeen();
      return;
    }
    let cancelled = false;
    repo.users.getAll().then(
      (users) => {
        if (!cancelled) setOnlyUser({ userId: user.id, only: users.length === 1 });
      },
      () => undefined, // Unknown: leave the nudge hidden.
    );
    return () => {
      cancelled = true;
    };
  }, [repo, user, isDefault]);

  const dismiss = () => {
    markProfileIntroSeen();
    setDismissed(true);
  };

  // Storage is only read once the profile is ready (never during SSR or the
  // hydration render, which both see "loading"), so the markup can't mismatch.
  const show =
    active.status === "ready" &&
    isDefault &&
    !dismissed &&
    onlyUser?.userId === active.user.id &&
    onlyUser.only &&
    !hasSeenProfileIntro();
  if (!show) return { show: false, userName: null, partyName: null, dismiss };
  return { show: true, userName: active.user.name, partyName: active.partyProfile.name, dismiss };
}
