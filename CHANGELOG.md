# Changelog

All notable changes to Mailroom are documented here.

## [2.0.0] - 2026-11-25

Mailroom 2.0 expands from a Resend-style email platform into a complete open-source customer communication suite on your own Cloudflare Workers and Amazon SES — uniting transactional email, marketing, newsletters, B2B accounts, billing-driven automations, Intercom-style shared inbox, BYO AI copilot, live chat, changelog, and help center in one install.

### Added
- **Intercom-style 3-pane Shared Inbox & Live Hub**: split conversation list, real-time WebSocket/SSE updates (`/inbox-live`), saved views, macros, snooze, collision detection, desktop alerts, and multi-language Help Center (`en`/`es`/custom locales).
- **BYO AI Copilot, Auto-Responder & Auto-Triage**: plug in your own OpenAI, Anthropic, Gemini, OpenRouter, or Ollama key for grounded reply drafting, tone polish, thread summaries, automatic Help Center replies, **AI Auto-Triage** (tags, priority, frustrated-sentiment escalation), **AI email copywriting / subject brainstormer**, and **AI deflection & savings analytics** on Inbox Reports.
- **B2B Companies / Accounts**: `/companies`, `/companies/$id`, Inbox sidebar company card, `⌘K` global search, REST API (`/api/companies`), and auto-association of contacts by corporate domain (tracking plan, MRR, seats, and renewals).
- **Native Stripe, Polar & Lemon Squeezy Billing Sync**: HMAC-verified `/hooks/billing/:id` connectors that auto-sync contacts, B2B companies (plan & MRR), and normalized `billing.*` events, paired with **Failed-payment dunning**, **Trial ending**, and **Cancellation win-back** SaaS automation blueprints.
- **Upgraded Automation Webhooks**: custom `POST`/`PUT` methods, interpolated custom headers & JSON body templates (`{{{contact.*}}}` / `{{{event.*}}}`), SSRF protection against private/localhost hosts, and full UI configuration in the automation editor.
- **GitHub / Linear Issue Sync & Two-Way Slack Replies**: link issues inside the Inbox sidebar; signed `/hooks/issues/:orgId/:provider` webhooks mark issues closed, post an internal note, and auto-reopen conversations; signed `/hooks/slack/:orgId` webhooks route `conv_…` replies back into notes or live chat.
- **Standalone Public Changelog (`/changelog/<slug>`) & In-Widget Newsfeed**: branded changelog timeline with search, RSS 2.0 feed (`/changelog/<slug>/feed.xml`), emoji reactions (`🎉`, `❤️`, `🔥`, `👍`), and a matching **News** tab with unread dot inside the website chat widget.
- **Pluggable Brand Transports & One-Click Migration Importers**: optional per-brand **Resend** and **Postmark** transports alongside Amazon SES; CSV/JSON Contacts + Company importer and JSON Help Center importer in Settings.
- **Live OpenAPI 3.1 Spec, Zero-Dep TypeScript SDK & React Chat SDK**: public `GET /api/openapi.json`, `sdk/index.ts`, `sdk/react.tsx` (`<MailroomChat />` & `useMailroomChat()`), `mailroom dev` local sandbox, and expanded Docs snippets.
- **Full MCP Parity & Installable PWA**: 13 new MCP tools covering companies, billing connectors, issue links, transports, importers, and AI triage/copywriting, plus `manifest.webmanifest` for desktop/mobile install.

## [1.0.0] - 2026-11-11

- Initial open-source release: Resend-compatible transactional API on Amazon SES & Cloudflare Workers, visual broadcast editor, A/B subject tests, local-time sends, newsletters with RSS & referrals, automations canvas, shared & agent inboxes, website chat widget, help center, surveys, deliverability monitoring, multi-tenant SES isolation, and MCP server.
