"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js in production builds. Skipped in development so the
 * service worker cache doesn't mask hot-reloaded changes.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((error) => {
        console.error("Service worker registration failed:", error);
      });
  }, []);

  return null;
}
