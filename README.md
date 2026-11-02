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

### Container image

The multi-stage `Dockerfile` (deps → build → runner) does this for you. It produces a `node:22-alpine` image that runs as a non-root user and contains only the standalone server, `.next/static`, and `public/`. The build does not need `OPENAI_API_KEY`, and `.dockerignore` keeps every `.env*` file out of the build context.

```bash
docker build -t dm-friend:local .
docker run --rm -p 3000:3000 dm-friend:local                              # app works; AI features return missing_key
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=sk-... dm-friend:local     # with AI
```

### Kubernetes (Helm)

The chart lives in `deploy/helm/dm-friend`. It deploys one replica, a ClusterIP Service (port 80 → 3000, port name `http`), and a Tailscale operator Ingress (`ingressClassName: tailscale`, `tailscale.com/funnel: "false"`, `tls.hosts: [dmfriend]`). The app is served at `https://dmfriend.<tailnet>.ts.net`. Readiness and liveness probes hit `GET /`.

```bash
helm lint deploy/helm/dm-friend
helm template dm-friend deploy/helm/dm-friend

# Build and import the image into the k3d cluster (pullPolicy IfNotPresent, no registry)
docker build -t dm-friend:0.1.0 .
k3d image import dm-friend:0.1.0 -c <cluster>          # all nodes must be Ready

# Create the OpenAI Secret from your environment (the value never touches a file)
kubectl create namespace dm-friend
kubectl create secret generic dm-friend-openai -n dm-friend \
  --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY"

# Install, pointing at that Secret and the imported image tag
helm upgrade --install dm-friend deploy/helm/dm-friend -n dm-friend \
  --set image.tag=0.1.0 \
  --set openai.existingSecret=dm-friend-openai
```

For the OpenAI key, use `openai.existingSecret` to point at a Secret you created out of band (recommended — the key stays out of Helm values and git). Otherwise the chart templates its own Secret from `openai.apiKey`, which is empty by default, so pass it with `--set openai.apiKey=...` at install time and never commit it. Set `ingress.host`, `ingress.className`, `ingress.funnel`, and `ingress.annotations` in `values.yaml`.

The Tailscale operator derives the MagicDNS hostname from the ingress's `spec.tls.hosts` short name (`ingress.host`, default `dmfriend`) — not the ingress resource name. Read the assigned address with:

```bash
kubectl get ingress dm-friend -n dm-friend \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

On the Hercules cluster this serves the app at `https://dmfriend.tail18466c.ts.net` — reachable from any device on the tailnet, including a phone for installing the PWA. Note: `k3d image import` fails for a `NotReady` node; make sure `kubectl get nodes` shows all nodes `Ready` before importing.

### AI endpoints

The OpenAI key is read only on the server, per request, from `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, default `gpt-4o`). It is never sent to the client, and the app builds without it. Routes call a provider-agnostic `AiProvider` (`src/lib/ai/provider.ts`). Request/response types live in `src/lib/ai/contracts.ts`, which is safe to import from client code.

| Endpoint | Request body | 200 response |
| --- | --- | --- |
| `POST /api/ai/chat` | `{ messages: [{ role: "system" \| "user" \| "assistant", content }], temperature?, maxTokens? }` | `{ reply, usage? }` |
| `POST /api/ai/extract` | `{ imageDataUrl: "data:image/png;base64,..." }` or `{ imageBase64, mimeType }` (png/jpeg/webp/gif) | `{ data, raw, usage? }` (`data` follows the Character shape but is not yet validated) |

Errors return `{ error: { kind, message, issues? } }` with these statuses: `bad_request` 400, `rate_limited` 429, `missing_key` 500, `provider_error`/`invalid_response` 502, `timeout` 504. Messages are fixed strings, so upstream details never reach the client.

### PWA notes

- The manifest is generated from `src/app/manifest.ts` and served at `/manifest.webmanifest`.
- The service worker (`public/sw.js`) is registered only in production builds, so test offline/install behavior with `npm run build && npm start`, not `npm run dev`.
- Bump `VERSION` in `public/sw.js` to invalidate all client caches.
- Icons at `/icons/icon-192.png` and `/icons/icon-512.png` are placeholder PNGs rendered at build time by route handlers in `src/app/icons/`. To use real artwork, delete those route folders and drop PNGs at `public/icons/icon-192.png` and `public/icons/icon-512.png`.
