"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  type ChangeEvent,
} from "react";

import { CharacterForm } from "@/components/character-form";
import type { CharacterDraft } from "@/lib/character-form-values";
import {
  repository as defaultRepository,
  type Character,
  type Repository,
} from "@/lib/db";
import { extractCharacter } from "@/lib/scan/extract-client";
import {
  ACCEPTED_IMAGE_TYPES,
  checkImageDataUrl,
  checkImageFile,
  downscaleImage,
  readFileAsDataUrl,
} from "@/lib/scan/image";
import { assessDraft, fieldLabel, mapExtraction } from "@/lib/scan/map-extraction";

export type ScanScreenProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: Repository;
  /** Image preparation before upload; defaults to client-side downscaling. */
  prepareImage?: (dataUrl: string) => Promise<string>;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/*
 * Flow:
 *   idle ──pick file──▶ preparing ──▶ extracting ──ok──▶ review ──save──▶ saved
 *     ▲                    │              │                ▲
 *     │                    └─rejected─┐   └─error─▶ error ─┤ (retry → extracting,
 *     └──── choose different image ◀──┴────────────────────┘  manual → review)
 * `rejected` is idle with a message (bad type/size). Every async step carries a
 * run id so results from an abandoned image are ignored.
 */
type ScanState =
  | { step: "idle"; rejection?: string }
  | { step: "preparing"; run: number }
  | { step: "extracting"; run: number; image: string }
  | { step: "error"; image: string; message: string }
  | {
      step: "review";
      /** Run id; also keys the form so each new draft remounts it. */
      run: number;
      image?: string;
      draft: CharacterDraft;
      needsAttention: string[];
    }
  | { step: "saved"; character: Character };

type ScanAction =
  | { type: "reset"; rejection?: string }
  | { type: "prepare"; run: number }
  | { type: "extract"; run: number; image: string }
  | { type: "fail"; image: string; message: string }
  | { type: "review"; run: number; image?: string; draft: CharacterDraft }
  | { type: "saved"; character: Character };

function reducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case "reset":
      return { step: "idle", rejection: action.rejection };
    case "prepare":
      return { step: "preparing", run: action.run };
    case "extract":
      return { step: "extracting", run: action.run, image: action.image };
    case "fail":
      return { step: "error", image: action.image, message: action.message };
    case "review": {
      const draft = action.draft;
      return {
        step: "review",
        run: action.run,
        image: action.image,
        draft,
        needsAttention: action.image ? assessDraft(draft).needsAttention : [],
      };
    }
    case "saved":
      return { step: "saved", character: action.character };
  }
}

export function ScanScreen({
  repo = defaultRepository,
  prepareImage = downscaleImage,
  fetchImpl,
}: ScanScreenProps) {
  const inputId = useId();
  const hintId = useId();
  const attentionId = useId();
  const [state, dispatch] = useReducer(reducer, { step: "idle" });
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight extraction when leaving the screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Starts a new run, cancelling whatever the previous one was doing. */
  function nextRun(): number {
    abortRef.current?.abort();
    abortRef.current = null;
    return ++runRef.current;
  }

  async function runExtraction(image: string, run: number) {
    dispatch({ type: "extract", run, image });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await extractCharacter(image, {
        signal: controller.signal,
        fetchImpl,
      });
      if (run !== runRef.current) return;
      if (result.ok) {
        dispatch({
          type: "review",
          run,
          image,
          draft: mapExtraction(result.data, image),
        });
      } else {
        dispatch({ type: "fail", image, message: result.message });
      }
    } catch {
      // Only aborts reject; a newer run (or unmount) owns the state now.
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Clear so picking the same file again still fires a change.
    input.value = "";
    if (!file) return;

    const run = nextRun();
    const check = checkImageFile(file);
    if (!check.ok) {
      dispatch({ type: "reset", rejection: check.message });
      return;
    }

    dispatch({ type: "prepare", run });
    let image: string;
    try {
      image = await prepareImage(await readFileAsDataUrl(file));
    } catch {
      if (run === runRef.current) {
        dispatch({ type: "reset", rejection: "Couldn't read that image. Try another." });
      }
      return;
    }
    if (run !== runRef.current) return;

    const sizeCheck = checkImageDataUrl(image);
    if (!sizeCheck.ok) {
      dispatch({ type: "reset", rejection: sizeCheck.message });
      return;
    }
    await runExtraction(image, run);
  }

  function startOver() {
    nextRun();
    dispatch({ type: "reset" });
  }

  function enterManually() {
    dispatch({ type: "review", run: nextRun(), draft: {} });
  }

  const statusMessage =
    state.step === "preparing"
      ? "Preparing image…"
      : state.step === "extracting"
        ? "Reading sheet…"
        : state.step === "review"
          ? state.image
            ? "Sheet read. Review the details below before saving."
            : ""
          : state.step === "saved"
            ? `Saved ${state.character.name} to the roster.`
            : "";

  const image =
    state.step === "extracting" || state.step === "error" || state.step === "review"
      ? state.image
      : undefined;

  const showPicker = state.step === "idle" || state.step === "error";

  return (
    <section className="scan" aria-labelledby="scan-title">
      <h2 id="scan-title" className="scan__title">
        Scan a character sheet
      </h2>

      {/* Always mounted so screen readers announce progress changes. */}
      <p className="scan__status" role="status" aria-live="polite">
        {statusMessage}
      </p>

      {state.step === "idle" && state.rejection && (
        <p className="scan__error" role="alert">
          {state.rejection}
        </p>
      )}

      {state.step === "error" && (
        <div className="scan__error-panel">
          <p className="scan__error" role="alert">
            {state.message}
          </p>
          <div className="scan__actions">
            <button
              type="button"
              className="scan__retry"
              onClick={() => runExtraction(state.image, nextRun())}
            >
              Try again
            </button>
            <button type="button" className="scan__manual" onClick={enterManually}>
              Enter manually
            </button>
          </div>
        </div>
      )}

      {image && (
        <figure className="scan__preview">
          {/* Local data URL preview; next/image doesn't apply. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="scan__preview-image"
            src={image}
            alt="Selected character sheet"
          />
        </figure>
      )}

      {showPicker && (
        <div className="scan__picker">
          <label htmlFor={inputId} className="scan__picker-label">
            {state.step === "error" ? "Choose a different image" : "Character sheet photo"}
          </label>
          <p id={hintId} className="scan__hint">
            Take a photo or choose an image (PNG, JPEG, WebP, or GIF).
          </p>
          <input
            id={inputId}
            className="scan__input"
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            capture="environment"
            aria-describedby={hintId}
            onChange={handleFile}
          />
          {state.step === "idle" && (
            <button type="button" className="scan__manual" onClick={enterManually}>
              Enter manually instead
            </button>
          )}
        </div>
      )}

      {(state.step === "preparing" || state.step === "extracting") && (
        <div className="scan__busy">
          <button type="button" className="scan__cancel" onClick={startOver}>
            Cancel
          </button>
        </div>
      )}

      {state.step === "review" && (
        <div className="scan__review">
          {state.needsAttention.length > 0 && (
            <div className="scan__attention">
              <p id={attentionId}>
                Check these fields — the AI couldn&apos;t read them or they look off:
              </p>
              <ul className="scan__attention-list" aria-labelledby={attentionId}>
                {state.needsAttention.map((path) => (
                  <li key={path}>{fieldLabel(path)}</li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="scan__retake" onClick={startOver}>
            {state.image ? "Retake or choose a different image" : "Scan a sheet instead"}
          </button>
          <CharacterForm
            key={state.run}
            repo={repo}
            initialValues={state.draft}
            onSaved={(character) => dispatch({ type: "saved", character })}
            onCancel={startOver}
          />
        </div>
      )}

      {state.step === "saved" && (
        <div className="scan__saved">
          <div className="scan__actions">
            <button type="button" className="scan__again" onClick={startOver}>
              Scan another
            </button>
            <Link href="/roster" className="scan__to-roster">
              Go to roster
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
