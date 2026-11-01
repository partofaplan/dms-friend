# DM Friend

An AI-powered, mobile-first Dungeon Master assistant for Dungeons & Dragons 5e.

DM Friend is a Progressive Web App (PWA) that helps a Dungeon Master during live play:

- **Scan character sheets** — photograph a sheet and let AI vision extract the stats into a party roster (with a manual entry fallback and a correction step).
- **Track the party** — a local-first roster of characters (HP, AC, ability scores, conditions, notes) stored on-device.
- **Look up monsters** — search SRD monsters (via the [Open5e API](https://api.open5e.com)) and read a combat-focused stat block.
- **Ask the AI assistant** — get rulings, dice recommendations, and encounter help, grounded in the current party and the monster you're looking at.

## Status

Early development. See the task breakdown driving the build in the project plan.

## Tech stack

- **Frontend:** Next.js (App Router) + TypeScript, Tailwind CSS, installable PWA (manifest + service worker)
- **Local storage:** IndexedDB via Dexie.js (local-first; cloud sync is a future extension)
- **Validation:** Zod
- **AI:** OpenAI GPT-4o (vision + chat), behind a provider interface so other providers can be added later
- **Monster data:** Open5e / SRD public API
- **Testing:** Vitest + React Testing Library
- **Packaging / hosting:** Docker + Helm, self-hosted on a k3d cluster, exposed via the Tailscale operator ingress + MagicDNS

## Architecture

```
Phone (Tailscale + MagicDNS)
  └─ DM Friend PWA  ──  local IndexedDB (roster)
        │
        ▼  Tailscale operator Ingress
  Next.js container (k3d cluster)
   ├─ UI routes
   └─ /api/ai, /api/monsters   ◄── OPENAI_API_KEY from a k8s Secret
        │                 │
        ▼                 ▼
   OpenAI GPT-4o     Open5e SRD API
```

The OpenAI key lives only in a Kubernetes Secret (and in gitignored local env files for development); it never ships to the client.

## Development

Requirements and setup instructions will be added as the scaffold lands.
