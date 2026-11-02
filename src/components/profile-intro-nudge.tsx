"use client";

import Link from "next/link";
import { useId } from "react";

import { PROFILES_NAV_ITEM } from "@/components/nav-items";
import { repository as defaultRepository, type AppRepository } from "@/lib/db";
import { useProfileIntro } from "@/lib/profiles/profile-intro";

export type ProfileIntroNudgeProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: AppRepository;
};

/*
 * A gentle, dismissible first-run callout (never a modal): suggests naming
 * the auto-created default profile and party. Renders nothing once dismissed
 * or once the user has renamed away from the default.
 */
export function ProfileIntroNudge({ repo = defaultRepository }: ProfileIntroNudgeProps) {
  const intro = useProfileIntro(repo);
  const titleId = useId();
  if (!intro.show) return null;

  return (
    <section className="profile-intro" aria-labelledby={titleId}>
      <h2 id={titleId} className="profile-intro__title">
        Make this table yours
      </h2>
      <p className="profile-intro__text">
        You&apos;re playing as “{intro.userName}” in “{intro.partyName}”. Name your profile and
        campaign so they&apos;re easy to find later.
      </p>
      <div className="profile-intro__actions">
        <Link href={PROFILES_NAV_ITEM.href} className="profile-intro__action">
          Name your profile
        </Link>
        <button
          type="button"
          className="profile-intro__dismiss"
          onClick={intro.dismiss}
          aria-label="Dismiss profile naming tip"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
