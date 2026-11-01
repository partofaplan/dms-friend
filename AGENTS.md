# Agent guide — DM Friend

Read this before making changes. It captures the stack, commands, and conventions so you don't have to rediscover them each session.

DM Friend is a mobile-first PWA that helps Dungeons & Dragons Dungeon Masters during live play: scan character sheets into a party roster, look up SRD monster stats, and ask an AI assistant for rulings, dice recommendations, and encounter help.

## Stack

- **Next.js 16 (App Router) + TypeScript**, `output: "standalone"`. Source under `src/`.
- **Tailwind CSS v4** (styles in `src/app/globals.css`, which defines the theme — reuse its variables).
- **Dexie.js over IndexedDB** for local-first storage (`src/lib/db/`).
- **Zod** for validation — schemas are the single source of truth; do not hand-duplicate validation rules.
- **OpenAI GPT-4o** behind a provider interface (`src/lib/ai/`), reached only through server routes.
- **Vitest + React Testing Library + jsdom** for tests. `fake-indexeddb` for headless IndexedDB.
- **Node.js 22 LTS or 24.** The build uses Turbopack by default.

## Commands (must all pass before a change is done)

```bash
npm run build     # production build; MUST succeed WITHOUT OPENAI_API_KEY set
npm run test      # vitest run (once, non-watch)
npm run lint      # eslint
```

- Verify a keyless build with `env -u OPENAI_API_KEY npm run build`.
- If a sandbox blocks the Turbopack dev-server port, `npm run build -- --webpack` is an equivalent production build for verification — say so if you used it.
- Do not run watch/dev servers in automation (`npm run dev`, `test:watch`); they block.

## Project conventions

- **Client vs server:** anything touching IndexedDB or the DOM is a client component (`"use client"`). Keep server components where no browser data is needed. Route handlers under `src/app/api/**` use `runtime = "nodejs"`.
- **Secrets:** `OPENAI_API_KEY` is read only server-side, per request, inside `getAiProvider()`. Never read it at module scope, never send it or raw provider error text to the client (OpenAI's 401 embeds a masked key — return fixed client-safe strings), never commit a real key. Only `.env.example` (placeholders) is tracked; `.env*.local` is gitignored. Server-only modules import `server-only`; `src/lib/ai/contracts.ts` stays client-importable (types + Zod only).
- **Storage:** all writes go through the repository (`src/lib/db/`) and are Zod-validated; ids via `crypto.randomUUID()`; `createdAt`/`updatedAt` set automatically. The repository is injectable so tests use a fresh `fake-indexeddb` per test.
- **Accessibility:** label every input, group checkboxes in `fieldset`/`legend`, wire errors with `aria-describedby`, give buttons accessible names. Tests query by role/label — don't break that wiring when restyling.
- **Styling hooks:** functional components use plain semantic markup with BEM-ish class names so the visual pass can style without rewiring. When doing a visual pass, change only styling/markup wrappers — never props, state, validation, routes, roles, labels, or `aria-*`.
- **Tests:** co-locate as `*.test.ts(x)`. Keep them hermetic (never hit the real OpenAI API or network) and isolated (fresh DB/state per test).

## Division of labor (two CLI agents build this repo)

- **Claude Code (Opus):** logic, state, storage, API routes, AI integration, tests, Docker/Helm/k8s. Builds the functional layer first.
- **Codex:** visual/UI only — styling, layout, color, typography, icons. Does the visual pass on the same branch after the logic lands, touching only presentation.
- Keep the dark **ink-navy `#101820` / ivory `#f2ede3` / brass `#d8b77a`** theme consistent across screens.

## Git / review

- Branch per task (`feat/…`, `fix/…`, `design/…`); never commit to `main`. The orchestrator commits, opens the PR, and merges — delegated CLI runs leave the working tree changed and do NOT commit or push unless told to.
- Every PR gets an independent cross-tool review before merge.
