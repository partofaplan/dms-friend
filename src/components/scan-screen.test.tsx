import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DexieRepository } from "@/lib/db";
import { MAX_IMAGE_BASE64_LENGTH } from "@/lib/ai/contracts";
import { createTestRepository } from "@/test-utils/repository";

import { ScanScreen } from "./scan-screen";

let repo: DexieRepository;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  repo = createTestRepository();
  fetchMock = vi.fn<typeof fetch>();
});

afterEach(() => {
  repo.db.close();
});

const identity = async (dataUrl: string) => dataUrl;

function renderScan(prepareImage = identity) {
  return render(
    <ScanScreen repo={repo} fetchImpl={fetchMock} prepareImage={prepareImage} />,
  );
}

function pngFile(name = "sheet.png") {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type: "image/png",
  });
}

function pick(file: File) {
  fireEvent.change(screen.getByLabelText(/Character sheet photo|Choose a different image/), {
    target: { files: [file] },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const extracted = {
  name: "Ilsa",
  race: "High Elf",
  className: "Wizard",
  level: "5",
  armorClass: 12,
  hitPoints: { max: 22, current: null, temporary: null },
  abilityScores: {
    strength: 8,
    dexterity: 14,
    constitution: 12,
    intelligence: 18,
    wisdom: 13,
    charisma: 10,
  },
  savingThrowProficiencies: ["intelligence", "wisdom"],
  skillProficiencies: ["arcana", "basket weaving"],
  passivePerception: 11,
  conditions: [],
  notes: null,
};

function textbox(name: string) {
  return screen.getByRole("textbox", { name });
}

function spinbutton(name: string) {
  return screen.getByRole("spinbutton", { name });
}

describe("ScanScreen", () => {
  it("labels the file input for camera capture and image upload", () => {
    renderScan();
    const input = screen.getByLabelText("Character sheet photo");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("capture", "environment");
    expect(input).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp,image/gif",
    );
  });

  it("rejects an unsupported file type without calling the API", async () => {
    renderScan();
    pick(new File(["%PDF"], "sheet.pdf", { type: "application/pdf" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /file type isn't supported/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before reading or uploading it", async () => {
    renderScan();
    const file = pngFile();
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 });
    pick(file);

    expect(await screen.findByRole("alert")).toHaveTextContent(/too large/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an image that is still over the extract limit after preparing", async () => {
    const huge = `data:image/png;base64,${"A".repeat(MAX_IMAGE_BASE64_LENGTH + 4)}`;
    renderScan(async () => huge);
    pick(pngFile());

    expect(await screen.findByRole("alert")).toHaveTextContent(/too large/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts a picked image and pre-fills the form with mapped values", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    renderScan();
    pick(pngFile());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Reading sheet…"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/extract");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByRole("img", { name: "Selected character sheet" })).toHaveAttribute(
      "src",
      body.imageDataUrl,
    );

    resolveFetch(jsonResponse({ data: extracted, raw: "{}" }));

    expect(await screen.findByRole("form", { name: "New character" })).toBeInTheDocument();
    expect(textbox("Name")).toHaveValue("Ilsa");
    expect(textbox("Race")).toHaveValue("High Elf");
    expect(textbox("Class")).toHaveValue("Wizard");
    expect(spinbutton("Level")).toHaveValue(5);
    expect(spinbutton("Max HP")).toHaveValue(22);
    expect(spinbutton("Current HP")).toHaveValue(null);
    expect(spinbutton("Intelligence")).toHaveValue(18);
    expect(screen.getByRole("checkbox", { name: "Arcana" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Wisdom" })).toBeChecked();
    // The unreadable field is called out for review.
    expect(screen.getByRole("list", { name: /Check these fields/ })).toHaveTextContent(
      "Current HP",
    );
  });

  it("saves the reviewed character to the repository with its source scan", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: extracted, raw: "{}" }));
    const create = vi.spyOn(repo.characters, "create");
    renderScan();
    pick(pngFile());

    await screen.findByRole("form", { name: "New character" });
    const image = screen
      .getByRole("img", { name: "Selected character sheet" })
      .getAttribute("src");
    fireEvent.change(spinbutton("Current HP"), { target: { value: "15" } });
    fireEvent.change(textbox("Name"), { target: { value: "Ilsa Brightwater" } });
    fireEvent.click(screen.getByRole("button", { name: "Add character" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Saved Ilsa Brightwater to the roster.",
      ),
    );
    expect(create).toHaveBeenCalledTimes(1);
    const saved = await repo.characters.getAll();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: "Ilsa Brightwater",
      className: "Wizard",
      level: 5,
      hitPoints: { max: 22, current: 15, temporary: 0 },
      skillProficiencies: ["arcana"],
      rawScan: image,
    });
    expect(screen.getByRole("link", { name: "Go to roster" })).toHaveAttribute(
      "href",
      "/roster",
    );
    // Let next/link's deferred post-mount (prefetch visibility) update settle inside act.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    fireEvent.click(screen.getByRole("button", { name: "Scan another" }));
    expect(screen.getByLabelText("Character sheet photo")).toBeInTheDocument();
  });

  it("shows a friendly message on an extract error and can retry", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { kind: "provider_error", message: "upstream 500: sk-***abc" } },
          502,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ data: extracted, raw: "{}" }));
    renderScan();
    pick(pngFile());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't read that sheet/);
    expect(alert).not.toHaveTextContent(/upstream|sk-/);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Choose a different image")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("form", { name: "New character" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(textbox("Name")).toHaveValue("Ilsa");
  });

  it("falls back to an empty manual form when extraction fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { kind: "missing_key", message: "x" } }, 500),
    );
    renderScan();
    pick(pngFile());

    expect(await screen.findByRole("alert")).toHaveTextContent(/AI isn't configured/);
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));

    expect(screen.getByRole("form", { name: "New character" })).toBeInTheDocument();
    expect(textbox("Name")).toHaveValue("");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("lets the user retake from the review step", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: extracted, raw: "{}" }));
    renderScan();
    pick(pngFile());
    await screen.findByRole("form", { name: "New character" });

    fireEvent.click(
      screen.getByRole("button", { name: "Retake or choose a different image" }),
    );

    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Character sheet photo")).toBeInTheDocument();
  });
});
