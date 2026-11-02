"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  ImportError,
  LastUserProfileError,
  repository as defaultRepository,
  ValidationError,
  type AppRepository,
  type PartyProfile,
  type UserProfile,
} from "@/lib/db";
import {
  refreshActiveProfile,
  setActiveParty,
  setActiveUser,
  useActiveProfile,
} from "@/lib/profiles/active-profile";
import { markProfileIntroSeen } from "@/lib/profiles/profile-intro";

export type ProfilesScreenProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: AppRepository;
  /** Saves an export file; injectable for tests. Defaults to a browser download. */
  download?: (filename: string, json: string) => void;
  /** Reads a picked import file; injectable for tests. */
  readFile?: (file: File) => Promise<string>;
};

type Notice = { kind: "status" | "error"; text: string } | null;

/** Triggers a browser download of `json` as `filename`. */
export function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** "dm-friend-curse-of-strahd.json"-style name for a user's export. */
export function exportFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `dm-friend-${slug || "profile"}.json`;
}

function failure(error: unknown, fallback: string): string {
  if (error instanceof LastUserProfileError) {
    return "You can't delete the only user profile. Create another one first.";
  }
  if (error instanceof ImportError) {
    return "That file isn't a DM Friend profile export, so nothing was imported.";
  }
  if (error instanceof ValidationError) return "Enter a name.";
  return fallback;
}

/*
 * "Who's playing?" picker plus management. Choosing a user makes them (and
 * their last party) active and returns home. Users can be created, renamed,
 * exported, imported and deleted; the active user's parties can be switched,
 * created, renamed and deleted. Every change refreshes the active selection,
 * which self-heals off anything just deleted. Results are announced through
 * one status/alert line.
 */
export function ProfilesScreen({
  repo = defaultRepository,
  download = downloadJson,
  readFile = (file) => file.text(),
}: ProfilesScreenProps) {
  const router = useRouter();
  const active = useActiveProfile(repo);
  const [users, setUsers] = useState<UserProfile[] | null>(null);
  const [parties, setParties] = useState<PartyProfile[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const importId = useId();
  const usersHeadingRef = useRef<HTMLHeadingElement>(null);
  const partiesHeadingRef = useRef<HTMLHeadingElement>(null);

  const activeUser = active.user;
  const activeUserId = activeUser?.id ?? null;
  const activePartyId = active.partyProfile?.id ?? null;

  const loadUsers = useCallback(async () => setUsers(await repo.users.getAll()), [repo]);

  useEffect(() => {
    let cancelled = false;
    repo.users.getAll().then(
      (all) => {
        if (!cancelled) setUsers(all);
      },
      () => {
        if (!cancelled) setNotice({ kind: "error", text: "Could not load profiles." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repo]);

  // Re-read whenever the active profile is (re)resolved, e.g. after a rename.
  useEffect(() => {
    if (!activeUserId) return;
    let cancelled = false;
    repo.partyProfiles.listByUser(activeUserId).then(
      (all) => {
        if (!cancelled) setParties(all);
      },
      () => {
        if (!cancelled) setNotice({ kind: "error", text: "Could not load parties." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repo, activeUserId, active.partyProfile]);

  /** Runs one change at a time, then refreshes the lists and active selection. */
  async function run(task: () => Promise<string | void>, fallback: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const done = await task();
      await refreshActiveProfile(repo);
      await loadUsers();
      if (done) setNotice({ kind: "status", text: done });
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: failure(error, fallback) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function chooseUser(user: UserProfile) {
    setBusy(true);
    setNotice(null);
    try {
      await setActiveUser(user.id, repo);
      router.push("/");
    } catch (error) {
      setNotice({ kind: "error", text: failure(error, `Could not switch to ${user.name}.`) });
      setBusy(false);
    }
  }

  async function exportUser(user: UserProfile) {
    setNotice(null);
    try {
      const data = await repo.exportUserProfile(user.id);
      download(exportFilename(user.name), JSON.stringify(data, null, 2));
      setNotice({ kind: "status", text: `Exported ${user.name}.` });
    } catch (error) {
      setNotice({ kind: "error", text: failure(error, `Could not export ${user.name}.`) });
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    await run(async () => {
      try {
        const user = await repo.importUserProfile(await readFile(file));
        return `Imported ${user.name}.`;
      } finally {
        input.value = ""; // So picking the same file again still fires a change.
      }
    }, "Could not import that file.");
  }

  const ready = users !== null && active.status === "ready";

  return (
    <div className="profiles">
      <p
        role={notice?.kind === "error" ? "alert" : "status"}
        className={`profiles__notice${notice ? ` profiles__notice--${notice.kind}` : ""}`}
      >
        {notice?.text ?? ""}
      </p>

      <section className="profiles__section profiles__users" aria-labelledby="profiles-users-title">
        <h2 id="profiles-users-title" ref={usersHeadingRef} tabIndex={-1}>
          Who&apos;s playing?
        </h2>
        {!ready ? (
          <p className="profiles__loading" role="status">
            Loading profiles…
          </p>
        ) : (
          <ul className="profiles__list" aria-label="User profiles">
            {users.map((user) => {
              const isActive = user.id === activeUserId;
              return (
                <ManagedItem
                  key={user.id}
                  className="profile-card"
                  name={user.name}
                  current={isActive}
                  currentLabel="Playing now"
                  busy={busy}
                  deleteWarning={`Delete ${user.name}? This removes all of ${user.name}'s parties, characters, monster stable and chat. This cannot be undone.`}
                  onRename={(name) =>
                    run(async () => {
                      await repo.users.rename(user.id, name);
                      // Naming a profile completes the first-run intro for good.
                      markProfileIntroSeen();
                      return `Renamed to ${name.trim()}.`;
                    }, `Could not rename ${user.name}.`)
                  }
                  onDelete={() =>
                    run(async () => {
                      await repo.users.delete(user.id);
                      usersHeadingRef.current?.focus();
                      return `Deleted ${user.name}.`;
                    }, `Could not delete ${user.name}.`)
                  }
                >
                  <button
                    type="button"
                    className="profile-card__choose"
                    onClick={() => void chooseUser(user)}
                    disabled={busy}
                  >
                    Play as {user.name}
                  </button>
                  <button
                    type="button"
                    className="profile-card__export"
                    onClick={() => void exportUser(user)}
                    disabled={busy}
                    aria-label={`Export ${user.name}`}
                  >
                    Export
                  </button>
                </ManagedItem>
              );
            })}
          </ul>
        )}

        <NameForm
          className="profiles__create"
          label="New user name"
          submitLabel="Create user"
          busy={busy}
          onSubmit={(name) =>
            run(async () => {
              const user = await repo.users.create(name);
              return `Created ${user.name}.`;
            }, "Could not create the user.")
          }
        />

        <div className="profiles__import">
          <label htmlFor={importId}>Import a profile</label>
          <input
            id={importId}
            type="file"
            accept="application/json,.json"
            onChange={(event) => void importFile(event)}
            disabled={busy}
          />
        </div>
      </section>

      {ready && activeUser && (
        <section className="profiles__section profiles__parties" aria-labelledby="profiles-parties-title">
          <h2 id="profiles-parties-title" ref={partiesHeadingRef} tabIndex={-1}>
            {activeUser.name}&apos;s parties
          </h2>
          {parties === null ? (
            <p className="profiles__loading" role="status">
              Loading parties…
            </p>
          ) : parties.length === 0 ? (
            <div className="profiles__empty">
              <p>No campaigns yet.</p>
              <p>Create a party below to start tracking a campaign.</p>
            </div>
          ) : (
            <ul className="profiles__list" aria-label={`${activeUser.name}'s parties`}>
              {parties.map((party) => {
                const isActive = party.id === activePartyId;
                return (
                  <ManagedItem
                    key={party.id}
                    className="party-card"
                    name={party.name}
                    current={isActive}
                    currentLabel="Active party"
                    busy={busy}
                    deleteWarning={`Delete ${party.name}? This removes its characters, monster stable and chat. This cannot be undone.`}
                    onRename={(name) =>
                      run(async () => {
                        await repo.partyProfiles.rename(party.id, name);
                        return `Renamed to ${name.trim()}.`;
                      }, `Could not rename ${party.name}.`)
                    }
                    onDelete={() =>
                      run(async () => {
                        await repo.partyProfiles.delete(party.id);
                        partiesHeadingRef.current?.focus();
                        return `Deleted ${party.name}.`;
                      }, `Could not delete ${party.name}.`)
                    }
                  >
                    <button
                      type="button"
                      className="party-card__switch"
                      onClick={() =>
                        void run(async () => {
                          await setActiveParty(party.id, repo);
                          return `Switched to ${party.name}.`;
                        }, `Could not switch to ${party.name}.`)
                      }
                      disabled={busy || isActive}
                      aria-pressed={isActive}
                    >
                      {isActive ? `Playing ${party.name}` : `Switch to ${party.name}`}
                    </button>
                  </ManagedItem>
                );
              })}
            </ul>
          )}

          <NameForm
            className="profiles__create"
            label="New party name"
            submitLabel="Create party"
            busy={busy}
            onSubmit={(name) => {
              const userId = activeUser.id;
              return run(async () => {
                const party = await repo.partyProfiles.create(userId, name);
                await setActiveParty(party.id, repo);
                return `Created ${party.name} and made it the active party.`;
              }, "Could not create the party.");
            }}
          />
        </section>
      )}
    </div>
  );
}

type ManagedItemProps = {
  className: string;
  name: string;
  current: boolean;
  currentLabel: string;
  busy: boolean;
  deleteWarning: string;
  /** Resolves true when the rename was saved. */
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  /** The item's own actions (choose, switch, export…). */
  children: ReactNode;
};

/** A list entry with inline rename and a confirmed delete; focus follows each step. */
function ManagedItem({
  className,
  name,
  current,
  currentLabel,
  busy,
  deleteWarning,
  onRename,
  onDelete,
  children,
}: ManagedItemProps) {
  const headingId = useId();
  const [mode, setMode] = useState<"idle" | "renaming" | "confirming">("idle");
  const renameRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previous = useRef(mode);

  // Into the confirmation when it opens; back to the button that opened a
  // step when it's cancelled or done.
  useEffect(() => {
    if (mode === "confirming") confirmRef.current?.focus();
    else if (mode === "idle" && previous.current === "confirming") deleteRef.current?.focus();
    else if (mode === "idle" && previous.current === "renaming") renameRef.current?.focus();
    previous.current = mode;
  }, [mode]);

  return (
    <li className={`${className}${current ? ` ${className}--current` : ""}`} aria-current={current || undefined}>
      <article aria-labelledby={headingId}>
        <h3 id={headingId} className={`${className}__name`}>
          {name}
        </h3>
        {current && <p className={`${className}__current`}>{currentLabel}</p>}

        {mode === "renaming" ? (
          <NameForm
            className={`${className}__rename`}
            label={`New name for ${name}`}
            submitLabel="Save name"
            initialValue={name}
            busy={busy}
            autoFocus
            onSubmit={async (next) => {
              if (await onRename(next)) setMode("idle");
              return false; // Keep the typed name; the form closes on success anyway.
            }}
            onCancel={() => setMode("idle")}
          />
        ) : mode === "confirming" ? (
          <div className={`${className}__confirm`} role="group" aria-label={`Confirm deleting ${name}`}>
            <p>{deleteWarning}</p>
            <button
              ref={confirmRef}
              type="button"
              onClick={async () => {
                if (!(await onDelete())) setMode("idle");
              }}
              disabled={busy}
            >
              Confirm delete
            </button>
            <button type="button" onClick={() => setMode("idle")} disabled={busy}>
              Cancel
            </button>
          </div>
        ) : (
          <div className={`${className}__actions`}>
            {children}
            <button
              ref={renameRef}
              type="button"
              onClick={() => setMode("renaming")}
              disabled={busy}
              aria-label={`Rename ${name}`}
            >
              Rename
            </button>
            <button
              ref={deleteRef}
              type="button"
              onClick={() => setMode("confirming")}
              disabled={busy}
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

type NameFormProps = {
  className: string;
  label: string;
  submitLabel: string;
  initialValue?: string;
  busy: boolean;
  autoFocus?: boolean;
  /** Resolves true when the name was saved (the field is then cleared). */
  onSubmit: (name: string) => Promise<boolean>;
  onCancel?: () => void;
};

/** A one-field name form; a blank name is rejected inline. */
function NameForm({
  className,
  label,
  submitLabel,
  initialValue = "",
  busy,
  autoFocus,
  onSubmit,
  onCancel,
}: NameFormProps) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) {
      setError("Enter a name.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    if (await onSubmit(value)) setValue("");
  }

  return (
    <form className={`name-form ${className}`} onSubmit={handleSubmit} noValidate>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} className="name-form__error">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      )}
    </form>
  );
}
