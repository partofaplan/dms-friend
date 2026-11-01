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

### Requirements

- Node.js 22 LTS or 24 (some lint dependencies require `^20.19 || ^22.13 || >=24`)
- npm 10+

### Setup

```bash
npm install
cp .env.example .env.local   # then fill in OPENAI_API_KEY
```

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server at http://localhost:3000 |
| `npm test` | Run the Vitest suite once (`npm run test:watch` for watch mode) |
| `npm run lint` | Lint with ESLint |
| `npm run build` | Production build (`output: "standalone"`) |
| `npm start` | Serve the production build |

### Standalone output

`npm run build` emits a self-contained server in `.next/standalone`. To run it outside `npm start` (e.g. in a container), copy the static assets alongside it first:

```bash
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
node .next/standalone/server.js
```

### PWA notes

- The manifest is generated from `src/app/manifest.ts` and served at `/manifest.webmanifest`.
- The service worker (`public/sw.js`) is registered only in production builds, so test offline/install behavior with `npm run build && npm start`, not `npm run dev`.
- Bump `VERSION` in `public/sw.js` to invalidate all client caches.
- Icons at `/icons/icon-192.png` and `/icons/icon-512.png` are placeholder PNGs rendered at build time by route handlers in `src/app/icons/`. To use real artwork, delete those route folders and drop PNGs at `public/icons/icon-192.png` and `public/icons/icon-512.png`.
