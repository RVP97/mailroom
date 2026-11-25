# Reliability checklist

Each item has a trigger you can read from a diff, the check, and why it exists (a past incident or
standing rule). Before pushing, read your diff (`git diff origin/main...HEAD`), run only the items
whose trigger it matches (usually 2 to 6) and say which in the commit's `Verified:` trailer.

When something slips through to main (a revert, a Sentry issue, a failed deploy, a bug Rodrigo
finds), add an item here if a diff could have shown it, in the same commit as the fix. Prune items
whose check became a script or a test, or whose code is gone.

| # | Trigger in the diff | Check | Why |
|---|---|---|---|
| 1 | Code that runs when a module loads and touches `env` (a binding wrapped, read or called at the top level) | Read bindings when they're used, not at startup: Cloudflare's deploy-time check loads the Worker with no bindings. | 2026-11-05: `withRetry` wrapped `env.DB` in a Proxy at load and every deploy was rejected (code 10021). |
| 2 | A dashboard page or component that reads `window`, `location`, `document` or `localStorage` while rendering | Read them in an effect or behind a browser check: the server draws every page's skeleton. | 2026-11-05: SSR of /docs and /domains/:id threw (MAILROOM-9, MAILROOM-A). |
| 3 | A page that calls `Route.useSearch()`, `useLoaderData()` or `useParams()` | Use `usePage(Route)` (`src/lib/sketch.tsx`); the hooks throw when the page is drawn as a skeleton outside its route. | 2026-11-06: Sign-up forms crashed on a click while loading. |
| 4 | A page's layout or its skeleton | With the dev server running, `bun run check:skeletons -- --paths /<page>` (Playwright; it opens the page with its calls held and fails when anything moves). | Skeletons must be the page (CLAUDE.md navigation rules). |
| 5 | A call to a Durable Object (`stub.fetch`, a room, the Dispatcher) | It's awaited inside the `try`, tries once more on a new stub when the error is retryable, then answers 503 or warns; it never escapes as an unhandled error. | 2026-11-11 MAILROOM-G, 2026-11-15 MAILROOM-K (chat rooms). |
| 6 | A side effect after the main write (kick the Dispatcher, push to a room, Seen, SLA, webhooks, logs) | It can't fail the request once the write is saved: best effort, reported as a warning. | 2026-11-05: `/api/emails/batch` answered 500 after queueing, inviting a resend (MAILROOM-B); 2026-11-12: chat sends showed a false «Not sent». |
| 7 | A send or reply endpoint the dashboard or an API client can call twice (retry, double click, lost answer) | The second call finds the first (client id, draft id) instead of failing or sending again. | 2026-11-12: a second Send on a chat draft said «Draft not found». |
| 8 | A new D1 read or claim loop, or a new error message D1 can return | Transient errors (`isTransient`, `src/server/db/retry.ts`) retry; the rest are reported. | 2026-11-11: D1's bare "internal error; reference = …" wasn't retried (MAILROOM-H, MAILROOM-J). |
| 9 | Dashboard code that reports a failed `fetch` to Sentry | Network failures (`isNetworkError`) aren't reported and the page retries or says Mailroom couldn't be reached. | 2026-11-06 MAILROOM-D, 2026-11-11 MAILROOM-F (phones waking up). |
| 10 | A `catch` around SES, AWS, Google, Cloudflare or another third party | The failure reaches Sentry (`reportError`, `src/server/sentry.ts`); it isn't swallowed or turned into an empty result. | Third-party failures must alert. |
| 11 | A server function, API route or MCP tool that loads a record by id (contact, segment, email, suppression, domain, IAM user) | The query narrows to the organization and brand; names built from user input (slugs) can't collide across organizations. | 2026-11-06 security audit: segments took other brands' contacts, SMTP IAM users named from slugs could be taken over. |
| 12 | A new action that sends, deletes or shows codes and card numbers | It checks the same permission in the dashboard, API and MCP (`broadcasts:send`, "See codes and card numbers"), and approvals cover its settings. | 2026-11-03 and 2026-11-06 security fixes: MCP sent and listed without the dashboard's checks. |
| 13 | Text from a request that goes into a header, CSS, HTML or a CSV | Line breaks refused in addresses, CSS escaped, CSV cells starting with = + - @ kept as text. | 2026-11-03 and 2026-11-06 security fixes. |
| 14 | A new or changed dashboard feature or action | The MCP has it too (`src/server/mcp`), in the same change. | The README promises the MCP can do anything the dashboard does. |
| 15 | A migration in `drizzle/` that drops or renames a column or table | The Worker live during the deploy still reads it (`deploy` applies migrations before `wrangler deploy`): keep it, and drop it in a later release. | A dropped column breaks the old Worker until the new one is live. |
| 16 | A new file in `drizzle/` | Its number is free on `origin/main` right now (fetch first); renumber yours if another thread took it. | Parallel threads clash on migration numbers. |
| 17 | A test that uses today's date, `Date.now()` or a month name | It pins the date or computes it from a fixed one. | Tests must not break when the date moves. |
| 18 | A multi-row `.values([...])` insert or `inArray(col, list)` over user/contact/webhook rows | Bound parameters stay under D1's 100-parameter limit (`Math.floor(95 / cols)` rows per insert, `<= 90` items per `inArray` alongside other bindings); large loops use `batch(...)`. | 2026-11-20: live segments failed past 33 matches (`50 * 3 = 150` params), and `companies.ts`/`webhooks.ts` could exceed 100 params. |
