# Mailroom

Self-hosted, Resend-style email on Amazon SES, running on Cloudflare Workers: TanStack Start
(`src/routes`), server code in `src/server`, D1 through Drizzle (migrations in `drizzle/`), the
MCP server in `src/server/mcp`. Biome formats with tabs, line width 100.

- `bun run typecheck` (tsc), `bun run lint` (Biome), `bun run test` (Vitest in the Workers pool,
  `vitest.config.ts`; tests in `test/`, AWS and Google calls go to fake fetches).
- Run the app from `.claude/launch.json` (port 3000, or the next free one).
- Finished work goes to `main`. Workers Builds deploys it with `bun run deploy`, which applies D1
  migrations before `wrangler deploy`. GitHub Actions runs typecheck and tests on every push.

## Verify before pushing

- **Run the change.** For anything a person sees or does, start the app from
  `.claude/launch.json` (use a dev server that's already running if there is one; don't restart
  Rodrigo's), do the flow in a browser at desktop and phone width, and check the console. Tests
  passing is not the same as the screen working. A page or skeleton change also gets
  `bun run check:skeletons -- --paths /<page>` against that dev server.
- **Run the checks:** `bun run typecheck`, Biome on the files you changed, and `bun run test`
  (or the test files your change touches, then the suite before a large push).
- **Read the diff against `docs/reliability-checklist.md`** and run the items it triggers. When a
  bug reaches main that a diff could have shown, add an item in the fix's commit.
- **Stamp the commit** with a `Verified:` trailer saying what ran, for example
  `Verified: typecheck, lint, test (75 files), browser /emails desktop+phone, skeletons /emails, checklist 2,6`.
  Write `Verified: none (<why>)` when nothing ran. `git log --grep "Verified: none"` finds them.
- **A hook runs fast gates before every `git push`** (`scripts/check-before-push.mjs`:
  check-org-urls, which the deploy runs first, and Biome on changed files; well under a second).
  If it blocks, fix the code. To push past a check that is itself wrong, prefix the command with
  `SKIP_PUSH_CHECKS="<reason>"`, and fix the check in its own commit.
- **Failing checks:** fix the cause. Never retry a test until it passes, add sleeps, widen a
  timeout or skip a test to get green. A flaky test is a bug in the test or the code; if you can't
  find the cause, say so instead of hiding it. After three rounds of fixes that still fail, stop
  and report what fails and what you tried.
- **Changes don't edit their own checks.** Don't loosen a test's assertion, the push hook,
  `check:skeletons` or this checklist in the same commit as the code it would have caught; a check
  that is wrong gets its own commit that says why.
