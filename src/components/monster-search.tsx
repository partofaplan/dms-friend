"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { MonsterStatBlock } from "@/components/monster-stat-block";
import { fetchMonsterDetail, fetchMonsterSearch } from "@/lib/monsters/client";
import type { MonsterStatBlock as MonsterStatBlockData, MonsterSummary } from "@/lib/monsters/types";

export const SEARCH_DEBOUNCE_MS = 300;

export type MonsterSearchProps = {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  debounceMs?: number;
};

type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "done"; query: string; results: MonsterSummary[] }
  | { status: "error"; message: string };

type DetailState =
  | { status: "idle" }
  | { status: "loading"; slug: string; name: string }
  | { status: "loaded"; monster: MonsterStatBlockData }
  | { status: "error"; slug: string; name: string; message: string };

function summaryMeta(monster: MonsterSummary): string {
  const kind = [monster.size, monster.type].filter(Boolean).join(" ");
  const cr = monster.challengeRating ? `CR ${monster.challengeRating}` : "";
  return [kind, cr].filter(Boolean).join(" · ");
}

function searchStatusText(search: SearchState): string {
  switch (search.status) {
    case "loading":
      return "Searching…";
    case "done": {
      const count = search.results.length;
      if (count === 0) return `No monsters found for “${search.query}”.`;
      return `${count} ${count === 1 ? "monster" : "monsters"} found.`;
    }
    default:
      return "";
  }
}

/*
 * Flow: typing schedules a debounced search (Enter searches immediately); each
 * new search aborts the previous request. Selecting a result fetches its full
 * stat block, aborting any in-flight detail request.
 */
export function MonsterSearch({ fetchImpl, debounceMs = SEARCH_DEBOUNCE_MS }: MonsterSearchProps) {
  const inputId = useId();
  const hintId = useId();
  const resultsHeadingId = useId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchController = useRef<AbortController | undefined>(undefined);
  const detailController = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(debounceTimer.current);
      searchController.current?.abort();
      detailController.current?.abort();
    },
    [],
  );

  function cancelPendingSearch() {
    clearTimeout(debounceTimer.current);
    searchController.current?.abort();
  }

  async function runSearch(term: string) {
    cancelPendingSearch();
    const controller = new AbortController();
    searchController.current = controller;
    setSearch({ status: "loading", query: term });
    try {
      const result = await fetchMonsterSearch(term, { signal: controller.signal, fetchImpl });
      if (controller.signal.aborted) return;
      setSearch(
        result.ok
          ? { status: "done", query: term, results: result.data }
          : { status: "error", message: result.message },
      );
    } catch {
      // Aborted by a newer search or unmount.
    }
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setQuery(value);
    cancelPendingSearch();
    const term = value.trim();
    if (!term) {
      setSearch({ status: "idle" });
      return;
    }
    debounceTimer.current = setTimeout(() => void runSearch(term), debounceMs);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (term) void runSearch(term);
  }

  async function selectMonster(summary: Pick<MonsterSummary, "slug" | "name">) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setDetail({ status: "loading", slug: summary.slug, name: summary.name });
    try {
      const result = await fetchMonsterDetail(summary.slug, { signal: controller.signal, fetchImpl });
      if (controller.signal.aborted) return;
      setDetail(
        result.ok
          ? { status: "loaded", monster: result.data }
          : { status: "error", slug: summary.slug, name: summary.name, message: result.message },
      );
    } catch {
      // Aborted by a newer selection or unmount.
    }
  }

  const selectedSlug =
    detail.status === "loaded" ? detail.monster.slug : detail.status === "idle" ? null : detail.slug;
  const results = search.status === "done" ? search.results : [];

  return (
    <div className="monster-search">
      <form role="search" className="monster-search__form" onSubmit={handleSubmit}>
        <label htmlFor={inputId} className="monster-search__label">
          Search monsters
        </label>
        <input
          id={inputId}
          type="search"
          className="monster-search__input"
          value={query}
          onChange={handleChange}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
        />
        <p id={hintId} className="monster-search__hint">
          Search the SRD by monster name, e.g. “goblin” or “dragon”.
        </p>
      </form>

      <p role="status" aria-live="polite" className="monster-search__status">
        {searchStatusText(search)}
      </p>
      {search.status === "error" && (
        <p role="alert" className="monster-search__error">
          {search.message}
        </p>
      )}

      <section
        className="monster-search__results"
        aria-labelledby={resultsHeadingId}
        hidden={results.length === 0}
      >
        <h2 id={resultsHeadingId} className="monster-search__results-title">
          Results
        </h2>
        <ul className="monster-results">
          {results.map((monster) => (
            <li key={monster.slug} className="monster-results__item">
              <button
                type="button"
                className="monster-results__button"
                aria-current={selectedSlug === monster.slug ? "true" : undefined}
                onClick={() => void selectMonster(monster)}
              >
                <span className="monster-results__name">{monster.name}</span>
                <span className="monster-results__meta">{summaryMeta(monster)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="monster-search__detail">
        <p role="status" aria-live="polite" className="monster-search__detail-status">
          {detail.status === "loading" ? `Loading ${detail.name}…` : ""}
        </p>
        {detail.status === "error" && (
          <div role="alert" className="monster-search__error">
            <p>{detail.message}</p>
            <button
              type="button"
              className="monster-search__retry"
              onClick={() => void selectMonster(detail)}
            >
              Try {detail.name} again
            </button>
          </div>
        )}
        {detail.status === "loaded" && <MonsterStatBlock monster={detail.monster} focusOnMount />}
      </div>
    </div>
  );
}
