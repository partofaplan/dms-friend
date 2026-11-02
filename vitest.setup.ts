import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { resetLastViewedMonsters } from "@/lib/chat/last-monster";
import { resetActiveProfileStore } from "@/lib/profiles/active-profile";

afterEach(() => {
  cleanup();
  // Module-level stores outlive a test; start each one with no active profile.
  resetActiveProfileStore();
  resetLastViewedMonsters();
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});
