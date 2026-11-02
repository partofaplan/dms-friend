"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NavIcon } from "@/components/nav-icon";
import { isActiveRoute, PRIMARY_NAV_ITEMS } from "@/components/nav-items";
import { useOnlineStatus } from "@/lib/pwa/online-status";

/*
 * Persistent primary navigation, mounted once in the root layout. The active
 * tab is derived from the pathname and exposed as aria-current="page" (styling
 * keys off the same attribute, so state never relies on color alone). While
 * offline, tabs whose screen needs the network get a visible "Offline" tag.
 */
export function BottomNav() {
  const pathname = usePathname();
  const online = useOnlineStatus();

  return (
    <nav className="bottom-nav" aria-label="Primary">
      <ul className="bottom-nav__list">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const active = isActiveRoute(item.href, pathname);
          const unavailable = !online && item.requiresNetwork;
          const className = [
            "bottom-nav__link",
            active && "bottom-nav__link--active",
            unavailable && "bottom-nav__link--unavailable",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={item.href} className="bottom-nav__item">
              <Link href={item.href} className={className} aria-current={active ? "page" : undefined}>
                <NavIcon name={item.icon} className="bottom-nav__icon" />
                <span className="bottom-nav__label">{item.label}</span>
                {/* The space keeps the accessible name "Chat Offline", not "ChatOffline". */}
                {unavailable && (
                  <>
                    {" "}
                    <span className="bottom-nav__badge">Offline</span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
