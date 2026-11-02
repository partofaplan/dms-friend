"use client";

import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

/*
 * Connectivity as the browser reports it. navigator.onLine is only a hint
 * (true can still mean "no route to the server"), so screens use it to explain
 * and pre-empt failures, not as a guarantee: a request that fails while
 * "online" still surfaces its own error.
 */

/** Current connectivity; true where it can't be known (SSR, no navigator). */
export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Re-renders on the browser's online/offline events. The server snapshot (and
 * the first hydration render) assume online so the markup matches; the real
 * value is applied right after hydration.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

/** Calls `onReconnect` each time the browser comes back online. */
export function useOnReconnect(onReconnect: () => void) {
  const handle = useEffectEvent(onReconnect);
  useEffect(() => {
    const listener = () => handle();
    window.addEventListener("online", listener);
    return () => window.removeEventListener("online", listener);
  }, []);
}
