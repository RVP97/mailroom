# Contributing to Mailroom

Thank you for helping make Mailroom better! Mailroom is an open-source, self-hosted email & customer messaging platform built on Cloudflare Workers, D1, R2, Durable Objects, TanStack Start, React 19, and Amazon SES.

## Quick start (zero AWS account required)

You can develop and test almost every feature locally without touching AWS:

1. **Install dependencies** (Bun 1.2+ or Node 20+):
   ```sh
   bun install
   ```
2. **Run the local interactive demo** (runs Mailroom's real server code inside your browser against an in-memory SQLite seed with 5 months of realistic data — zero AWS or Cloudflare accounts needed):
   ```sh
   bun run demo:dev
   ```
3. **Or run the full Cloudflare Worker locally**:
   ```sh
   cp .dev.vars.example .dev.vars
   bun run db:migrate:local
   bun run dev
   ```
   Sign-in OTP codes are printed directly in your dev terminal (no `SYSTEM_FROM` required).

See [docs/local-development.md](docs/local-development.md) for the full local development guide.

## Repository map

- `src/routes/` — TanStack Start routes (`src/routes/_app/` is the authenticated dashboard)
- `src/components/` — Reusable UI components (`src/components/inbox/` houses the 3-pane Inbox workspace)
- `src/functions/` — TanStack Start server functions (dashboard RPC boundary)
- `src/server/` — Core domain logic (SES sending, receiving, conversations, chat, automations, AI Copilot, MCP server)
- `src/server/mcp/` — Model Context Protocol tools (every dashboard action should have an MCP counterpart)
- `drizzle/` — Additive SQLite/D1 migrations
- `test/` — Vitest Workers pool suite (external AWS/Google/AI calls go to fake fetches)
- `demo/` — Self-contained browser demo build

## Before opening a pull request

1. **Checks**:
   ```sh
   bun run typecheck
   bun run lint
   bun run test
   ```
2. **Reliability checklist**: Review your diff against [docs/reliability-checklist.md](docs/reliability-checklist.md). Key rules:
   - Never read Cloudflare `env` bindings at module load time.
   - Never read `window`, `document`, or `localStorage` during render (SSR draws skeletons).
   - Use `usePage(Route)` instead of `Route.useLoaderData()` on dashboard pages so skeletons render cleanly.
   - Every new dashboard feature or action should include a matching MCP tool in `src/server/mcp/`.
   - D1 migrations in `drizzle/` must be additive (never drop a column in the same release that removes its reads).
3. **UI verification**: Test both desktop and phone widths, and run `bun run check:skeletons -- --paths /<page>` for layout changes.
4. **Formatting**: Biome formats with tabs and 100-char line width (`bun run format`).

## Issues & feature ideas

Check existing issues before opening a new one, and include reproduction steps or a brief motivation for new features.
