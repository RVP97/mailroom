# Local Development Guide

Mailroom is designed so you can build, test, and verify changes locally without needing an AWS account or live domain.

## 1. Fastest path: Interactive Demo Mode (no accounts needed)

```sh
bun install
bun run demo:dev
```

This builds a local SQLite database seeded with 5 months of realistic emails, broadcasts, automations, contacts, help articles, and inbox conversations (`demo/seed/`), and runs the real server code in your browser.

## 2. Full local Worker (`wrangler` + local D1/R2/DO)

```sh
cp .dev.vars.example .dev.vars
bun run db:migrate:local
bun run dev
```

Open `http://localhost:3000`. Sign in with an email listed in `ADMIN_EMAILS` inside `.dev.vars` — the 6-digit OTP code prints straight to the terminal output.

## 3. Running tests

Tests execute inside the real Cloudflare Workers runtime (`@cloudflare/vitest-pool-workers`) with outbound network calls intercepted by `test/setup.ts`:

```sh
# Full test suite
bun run test

# Single test file
bunx vitest run test/inbox-workflow.test.ts
```

## 4. Typecheck, lint & skeleton checks

```sh
bun run typecheck
bun run lint
bun run demo:build

# Verify zero-shift skeletons against a running local dev server:
bun run check:skeletons -- --paths /,/received,/settings
```

## 5. Adding a D1 migration

1. Update `src/server/db/schema.ts`.
2. Add the next numbered SQL file in `drizzle/` (e.g. `drizzle/0066_my_feature.sql`). Keep migrations strictly additive so the live Worker never breaks while a deploy applies migrations before uploading the new bundle.
3. Run `bun run db:migrate:local` and `bun run test`.
