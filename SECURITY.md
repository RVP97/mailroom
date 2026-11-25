# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Mailroom (authentication, tenant/brand isolation, XSS/HTML sanitization, SSRF, attachment handling, webhook verification, or secret storage), **please do not open a public GitHub issue**.

Instead, report it privately via GitHub Security Advisories (**Security → Advisories → Report a vulnerability**) on the repository.

Please include:
- A clear description of the issue and its impact
- Reproduction steps or a minimal proof of concept
- Affected commit/version if known

We aim to acknowledge reports within 48 hours and release fixes promptly. Security releases trigger an automatic non-dismissible red banner and admin email notification on self-hosted deployments.

## Security architecture notes

- **Encryption at rest**: Per-organization AWS keys and BYO AI API keys are encrypted with AES-GCM using a key derived from `BETTER_AUTH_SECRET`.
- **File safety**: All uploaded files and email attachments are validated in `src/lib/file-safety.ts` (magic bytes, zip bombs, SVG/XML DOCTYPE, pixel flood limits, executable/macro blocking).
- **Email HTML isolation**: Inbound HTML emails render inside sandboxed iframes (`sandbox=""`) with strict CSP and remote images blocked by default.
- **Role & tenant isolation**: Every server function, REST endpoint, and MCP tool checks permissions and scopes queries to the active organization and brand.
