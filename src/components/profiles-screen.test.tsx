import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { type DexieRepository } from "@/lib/db";
import { getActiveProfileIds, setActiveParty } from "@/lib/profiles/active-profile";
import { characterInput, createTestRepository } from "@/test-utils/repository";

import { ActiveScopeBar } from "./active-scope-bar";
import { exportFilename, ProfilesScreen } from "./profiles-screen";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let repo: DexieRepository;
let download: ReturnType<typeof vi.fn<(filename: string, json: string) => void>>;
/** Stands in for the browser's file read; returns the file's test contents. */
const fileContents = new WeakMap<File, string>();
const readFile = vi.fn(async (file: File) => fileContents.get(file) ?? "");

function jsonFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "application/json" });
  fileContents.set(file, contents);
  return file;
}

beforeEach(() => {
  repo = createTestRepository();
  download = vi.fn();
  push.mockReset();
  readFile.mockClear();
});

afterEach(() => {
  repo.db.close();
});

/** Zach (Strahd, Waterdeep) active on Strahd; Ana (Tomb). */
async function seed() {
  const zach = await repo.users.create("Zach");
  const strahd = await repo.partyProfiles.create(zach.id, "Strahd");
  const waterdeep = await repo.partyProfiles.create(zach.id, "Waterdeep");
  const ana = await repo.users.create("Ana");
  const tomb = await repo.partyProfiles.create(ana.id, "Tomb");
  await setActiveParty(strahd.id, repo);
  return { zach, strahd, waterdeep, ana, tomb };
}

async function renderScreen() {
  render(<ProfilesScreen repo={repo} download={download} readFile={readFile} />);
  await screen.findByRole("list", { name: "User profiles" });
  await screen.findByRole("list", { name: /'s parties$/ });
}

const users = () => screen.getByRole("list", { name: "User profiles" });
const parties = () => screen.getByRole("list", { name: /'s parties$/ });
const card = (list: HTMLElement, name: string) => within(list).getByRole("article", { name });
/** Clicks a button once the previous change has finished (controls are disabled while busy). */
async function click(name: string | RegExp) {
  const button = screen.getByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
const notice = () => screen.getByText((_, el) => el?.classList.contains("profiles__notice") ?? false);

describe("ProfilesScreen", () => {
  it("lists users with the active one marked, and the active user's parties", async () => {
    await seed();
    await renderScreen();

    expect(within(users()).getAllByRole("article").map((a) => a.querySelector("h3")?.textContent)).toEqual([
      "Ana",
      "Zach",
    ]);
    expect(card(users(), "Zach").closest("li")).toHaveAttribute("aria-current", "true");
    expect(card(users(), "Ana").closest("li")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("heading", { name: "Zach's parties" })).toBeInTheDocument();
    expect(within(parties()).getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Playing Strahd" })).toHaveAttribute("aria-pressed", "true");
  });

  it("choosing a user makes them active and returns to the app", async () => {
    const { ana, tomb } = await seed();
    await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Play as Ana" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(getActiveProfileIds()).toEqual({ userId: ana.id, partyProfileId: tomb.id });
  });

  it("creates, renames and deletes a user", async () => {
    await seed();
    await renderScreen();

    // Blank names are rejected inline.
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByLabelText("New user name")).toHaveAccessibleDescription("Enter a name.");

    fireEvent.change(screen.getByLabelText("New user name"), { target: { value: "Mira" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await within(users()).findByRole("article", { name: "Mira" })).toBeInTheDocument();
    // The notice and the cleared field land just after the list refresh.
    await waitFor(() => expect(notice()).toHaveTextContent("Created Mira."));
    await waitFor(() => expect(screen.getByLabelText("New user name")).toHaveValue(""));

    await click("Rename Mira");
    const field = screen.getByLabelText("New name for Mira");
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Mira the Bold" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await within(users()).findByRole("article", { name: "Mira the Bold" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename Mira the Bold" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Delete Mira the Bold" }));
    const confirm = within(card(users(), "Mira the Bold")).getByRole("group", {
      name: "Confirm deleting Mira the Bold",
    });
    expect(confirm).toHaveTextContent("removes all of Mira the Bold's parties, characters, monster stable and chat");
    expect(within(confirm).getByRole("button", { name: "Confirm delete" })).toHaveFocus();

    // Cancel returns focus to Delete.
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete Mira the Bold" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Delete Mira the Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(within(users()).queryByRole("article", { name: "Mira the Bold" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Who's playing?" })).toHaveFocus();
    expect((await repo.users.getAll()).map((u) => u.name)).toEqual(["Ana", "Zach"]);
  });

  it("deleting the active user switches to another user", async () => {
    const { zach, ana } = await seed();
    await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Delete Zach" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByRole("heading", { name: "Ana's parties" })).toBeInTheDocument();
    expect(getActiveProfileIds()?.userId).toBe(ana.id);
    expect(await repo.users.getById(zach.id)).toBeUndefined();
  });

  it("blocks deleting the last user with a friendly message", async () => {
    await repo.ensureDefaultProfile();
    await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Delete Default User" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can't delete the only user profile. Create another one first.",
    );
    expect(await repo.users.getAll()).toHaveLength(1);
    // The confirmation closes, returning focus to Delete.
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Default User" })).toHaveFocus());
  });

  it("switches, creates, renames and deletes parties", async () => {
    const { zach, waterdeep } = await seed();
    await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Waterdeep" }));
    expect(await screen.findByRole("button", { name: "Playing Waterdeep" })).toBeInTheDocument();
    expect(getActiveProfileIds()?.partyProfileId).toBe(waterdeep.id);

    // A new party becomes the active one.
    fireEvent.change(screen.getByLabelText("New party name"), { target: { value: "Saltmarsh" } });
    await click("Create party");
    expect(await screen.findByRole("button", { name: "Playing Saltmarsh" })).toBeInTheDocument();
    const saltmarsh = (await repo.partyProfiles.listByUser(zach.id)).find((p) => p.name === "Saltmarsh")!;
    expect(getActiveProfileIds()?.partyProfileId).toBe(saltmarsh.id);

    await click("Rename Strahd");
    fireEvent.change(screen.getByLabelText("New name for Strahd"), { target: { value: "Curse of Strahd" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await within(parties()).findByRole("article", { name: "Curse of Strahd" })).toBeInTheDocument();

    // Deleting the active party moves to another of the user's parties.
    await repo.forParty(saltmarsh.id).characters.create(characterInput());
    await click("Delete Saltmarsh");
    expect(screen.getByRole("group", { name: "Confirm deleting Saltmarsh" })).toHaveTextContent(
      "removes its characters, monster stable and chat",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(within(parties()).queryByRole("article", { name: "Saltmarsh" })).not.toBeInTheDocument(),
    );
    expect(await repo.forParty(saltmarsh.id).characters.getAll()).toEqual([]);
    const active = getActiveProfileIds()!;
    expect(active.userId).toBe(zach.id);
    expect(active.partyProfileId).not.toBe(saltmarsh.id);
    expect(await screen.findByRole("button", { name: /^Playing / })).toBeInTheDocument();
  });

  it("deleting a user's only party gives them a fresh one", async () => {
    const { partyProfile } = await repo.ensureDefaultProfile();
    await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Delete Default Party" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(getActiveProfileIds()?.partyProfileId).not.toBe(partyProfile.id));
    expect(await screen.findByRole("button", { name: "Playing Default Party" })).toBeInTheDocument();
  });

  it("exports a user profile as a JSON file", async () => {
    const { zach, strahd } = await seed();
    await repo.forParty(strahd.id).characters.create(characterInput({ name: "Brakka" }));
    await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Export Zach" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, json] = download.mock.calls[0];
    expect(filename).toBe("dm-friend-zach.json");
    expect(JSON.parse(json)).toEqual({
      ...(await repo.exportUserProfile(zach.id)),
      exportedAt: expect.any(String),
    });
    expect(JSON.parse(json).characters.map((c: { name: string }) => c.name)).toEqual(["Brakka"]);
    expect(notice()).toHaveTextContent("Exported Zach.");
  });

  it("imports an export as a new profile", async () => {
    const { zach } = await seed();
    const exported = JSON.stringify(await repo.exportUserProfile(zach.id));
    await renderScreen();

    const file = jsonFile("zach.json", exported);
    fireEvent.change(screen.getByLabelText("Import a profile"), { target: { files: [file] } });

    expect(await screen.findByText("Imported Zach.")).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith(file);
    await waitFor(() => expect(within(users()).getAllByRole("article", { name: "Zach" })).toHaveLength(2));
    expect(await repo.users.getAll()).toHaveLength(3);
  });

  it("explains a file that isn't an export, importing nothing", async () => {
    await seed();
    await renderScreen();

    const file = jsonFile("notes.json", "{not json");
    fireEvent.change(screen.getByLabelText("Import a profile"), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file isn't a DM Friend profile export, so nothing was imported.",
    );
    expect(await repo.users.getAll()).toHaveLength(2);
  });
});

describe("exportFilename", () => {
  it("slugs the user's name", () => {
    expect(exportFilename("Curse of Strahd!")).toBe("dm-friend-curse-of-strahd.json");
    expect(exportFilename("✨")).toBe("dm-friend-profile.json");
  });
});

describe("ActiveScopeBar", () => {
  it("shows the active user and party and switches parties", async () => {
    const { waterdeep } = await seed();
    render(<ActiveScopeBar repo={repo} />);

    const bar = screen.getByRole("region", { name: "Active profile" });
    expect(await within(bar).findByText("User: Zach")).toBeInTheDocument();
    expect(within(bar).getByText("Party: Strahd")).toBeInTheDocument();
    expect(within(bar).getByRole("link", { name: "Profiles" })).toHaveAttribute("href", "/profiles");

    const select = within(bar).getByLabelText("Active party");
    await waitFor(() =>
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Strahd",
        "Waterdeep",
      ]),
    );
    fireEvent.change(select, { target: { value: waterdeep.id } });
    expect(await within(bar).findByText("Party: Waterdeep")).toBeInTheDocument();
    expect(getActiveProfileIds()?.partyProfileId).toBe(waterdeep.id);
  });

  it("follows switches made elsewhere", async () => {
    const { tomb } = await seed();
    render(<ActiveScopeBar repo={repo} />);
    await screen.findByText("User: Zach");

    await act(() => setActiveParty(tomb.id, repo));
    expect(await screen.findByText("User: Ana")).toBeInTheDocument();
    expect(screen.getByText("Party: Tomb")).toBeInTheDocument();
  });
});
