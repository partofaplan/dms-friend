"use client";

import { useOnlineStatus } from "@/lib/pwa/online-status";

/**
 * App-wide connectivity banner. The live region stays mounted so going offline
 * (and coming back) is announced politely; it is empty while online.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  return (
    <div
      className={online ? "offline-banner" : "offline-banner offline-banner--visible"}
      role="status"
      aria-live="polite"
    >
      {!online && (
        <p className="offline-banner__text">
          You&apos;re offline. Your roster still works, as do your stable and profiles; monster
          lookup, chat, and scanning need a connection.
        </p>
      )}
    </div>
  );
}

/**
 * In-screen explanation for a feature that needs the network. Not a live
 * region itself: the banner already announces the change.
 */
export function OfflineNotice({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="offline-notice">
      <p className="offline-notice__title">You&apos;re offline</p>
      <p className="offline-notice__text">{children}</p>
    </div>
  );
}
