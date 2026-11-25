# Mailroom TypeScript SDK

Zero-dependency, typed client for Mailroom's full API (Emails, Templates, Contacts, Companies, Events, Broadcasts, Shared Inbox, and Status). Works in Node 18+, Bun, Deno, Cloudflare Workers, and browsers.

```ts
import { Mailroom } from "./sdk";

const mailroom = new Mailroom({
  url: process.env.MAILROOM_URL!,
  apiKey: process.env.MAILROOM_API_KEY!,
});

// 1. Send a transactional email
await mailroom.emails.send({
  from: "Acme <hello@acme.com>",
  to: "ana@customer.com",
  subject: "Welcome aboard",
  html: "<p>Thanks for joining!</p>",
});

// 2. Sync a B2B company & track a product event
await mailroom.companies.upsert({
  name: "Acme Corp",
  domain: "acme.com",
  plan: "Enterprise",
  mrr: 499,
  seats: 25,
});

await mailroom.events.track({
  event: "project.created",
  email: "ana@acme.com",
  data: { plan: "Enterprise" },
});
```

### OpenAPI 3.1 Specification

Every Mailroom deployment serves a live OpenAPI 3.1 JSON spec at:

```
GET https://<your-mailroom-host>/api/openapi.json
```
