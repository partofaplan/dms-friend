import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DEFAULT_USER_NAME, type DexieRepository } from "@/lib/db";
import { refreshActiveProfile } from "@/lib/profiles/active-profile";
import { PROFILE_INTRO_STORAGE_KEY } from "@/lib/profiles/profile-intro";
import { activateDefaultParty, createTestRepository } from "@/test-utils/repository";

import { ActiveScopeBar } from "./active-scope-bar";
import { ProfileIntroNudge } from "./profile-intro-nudge";
import { RosterScreen } from "./roster-screen";

let repo: DexieRepository;

beforeEach(() => {
  repo = createTestRepository();
});

afterEach(() => {
  repo.db.close();
});

const nudge = () => screen.queryByRole("region", { name: "Make this table yours" });

/** Renders the nudge beside the scope bar and waits until the profile has resolved. */
async function renderNudge() {
  const result = render(
    <>
      <ActiveScopeBar repo={repo} />
      <ProfileIntroNudge repo={repo} />
    </>,
  );
  await screen.findByText(/^User: /);
  // Let the nudge's own user-count check settle before asserting either way.
  await act(async () => {});
  return result;
}

describe("ProfileIntroNudge", () => {
  it("invites a brand-new user to name the auto-created default profile", async () => {
    await renderNudge();

    const region = await screen.findByRole("region", { name: "Make this table yours" });
    expect(region).toHaveTextContent("You're playing as “Default User” in “Default Party”.");
    expect(screen.getByRole("link", { name: "Name your profile" })).toHaveAttribute("href", "/profiles");
    // A callout, never a modal wall.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays dismissed once dismissed, across remounts", async () => {
    const { unmount } = await renderNudge();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss profile naming tip" }));

    expect(nudge()).not.toBeInTheDocument();
    expect(window.localStorage.getItem(PROFILE_INTRO_STORAGE_KEY)).toBe("true");

    unmount();
    await renderNudge();
    expect(nudge()).not.toBeInTheDocument();
  });

  it("goes away for good once the user renames away from the default", async () => {
    const { user } = await activateDefaultParty(repo);
    await renderNudge();
    expect(nudge()).toBeInTheDocument();

    await act(async () => {
      await repo.users.rename(user.id, "Zach");
      await refreshActiveProfile(repo);
    });
    await waitFor(() => expect(nudge()).not.toBeInTheDocument());
    await waitFor(() => expect(window.localStorage.getItem(PROFILE_INTRO_STORAGE_KEY)).toBe("true"));

    // Renaming back doesn't bring it back.
    await act(async () => {
      await repo.users.rename(user.id, DEFAULT_USER_NAME);
      await refreshActiveProfile(repo);
    });
    await screen.findByText(`User: ${DEFAULT_USER_NAME}`);
    await act(async () => {});
    expect(nudge()).not.toBeInTheDocument();
  });

  it("isn't shown when the active user already has a name", async () => {
    const zach = await repo.users.create("Zach");
    await repo.partyProfiles.create(zach.id, "Strahd");
    await renderNudge();

    expect(nudge()).not.toBeInTheDocument();
  });

  it("isn't shown on a default-named user when other users exist", async () => {
    await activateDefaultParty(repo);
    await repo.users.create("Ana");
    await renderNudge();

    expect(nudge()).not.toBeInTheDocument();
  });

  it("doesn't block using the app while it's showing", async () => {
    render(
      <>
        <ProfileIntroNudge repo={repo} />
        <RosterScreen repo={repo} />
      </>,
    );
    expect(await screen.findByRole("region", { name: "Make this table yours" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Add character" }));
    expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument();
  });
});
