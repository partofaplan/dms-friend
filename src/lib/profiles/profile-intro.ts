import { useEffect, useState } from "react";

import { DEFAULT_USER_NAME, repository as defaultRepository, type AppRepository } from "@/lib/db";
import { useActiveProfile } from "@/lib/profiles/active-profile";

/*
 * The first-run "name your profile" nudge. A fresh install lands in the
 * auto-created "Default User" / "Default Party"; until the user dismisses the
 * nudge or renames a user profile, it suggests naming them. Both actions call
 * markProfileIntroSeen(), remembered in localStorage so the nudge never comes
 * back, even if the name is later changed back to the default. The hook only
 * reads that flag; it never sets it as a side effect of rendering. Client only.
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
  // The user that was checked, and whether the nudge applies to them: the only
  // user, with the intro not yet seen. Storage is read here, in an effect after
  // mount, never during render.
  const [check, setCheck] = useState<{ userId: string; eligible: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const user = active.user;
  const isDefault = user?.name === DEFAULT_USER_NAME;

  useEffect(() => {
    if (!user || !isDefault) return;
    let cancelled = false;
    repo.users.getAll().then(
      (users) => {
        if (cancelled) return;
        setCheck({ userId: user.id, eligible: users.length === 1 && !hasSeenProfileIntro() });
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

  // SSR and the hydration render have no check yet, so they render nothing.
  const show =
    active.status === "ready" &&
    isDefault &&
    !dismissed &&
    check?.userId === active.user.id &&
    check.eligible;
  if (!show) return { show: false, userName: null, partyName: null, dismiss };
  return { show: true, userName: active.user.name, partyName: active.partyProfile.name, dismiss };
}
