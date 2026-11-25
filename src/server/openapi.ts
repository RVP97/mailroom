/**
 * Live OpenAPI 3.1 specification for Mailroom's HTTP API, served at GET /api/openapi.json.
 * Covers Emails (Resend-compatible), Templates, Broadcasts, Contacts, Companies, Events,
 * Automations, Shared Inboxes, Help Center, Domains, Webhooks, and Status.
 */
export function buildOpenApiSpec(serverOrigin: string) {
	const base = `${serverOrigin.replace(/\/$/, "")}/api`;
	return {
		openapi: "3.1.0",
		info: {
			title: "Mailroom API",
			version: "1.0.0",
			description:
				"Open-source transactional email, newsletters, automations, shared inbox, website chat, and help center API on Cloudflare Workers + Amazon SES. Compatible with Resend SDKs for transactional sends.",
			license: { name: "MIT", url: "https://github.com/RVP97/mailroom/blob/main/LICENSE" },
		},
		servers: [{ url: base }],
		security: [{ bearerAuth: [] }],
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "Mailroom API key (mr_…) from Settings › API keys.",
				},
			},
			schemas: {
				Error: {
					type: "object",
					properties: {
						statusCode: { type: "integer" },
						name: { type: "string" },
						message: { type: "string" },
					},
				},
				SendEmailRequest: {
					type: "object",
					required: ["from", "to"],
					properties: {
						from: { type: "string", example: "Acme <hello@acme.com>" },
						to: {
							oneOf: [
								{ type: "string" },
								{ type: "array", items: { type: "string" } },
							],
						},
						cc: { type: "array", items: { type: "string" } },
						bcc: { type: "array", items: { type: "string" } },
						reply_to: { type: "array", items: { type: "string" } },
						subject: { type: "string" },
						html: { type: "string" },
						text: { type: "string" },
						scheduled_at: { type: "string", format: "date-time" },
						unsubscribe_group: { type: "string" },
						template: {
							type: "object",
							properties: {
								id: { type: "string" },
								variables: { type: "object", additionalProperties: true },
							},
						},
						tags: {
							type: "array",
							items: {
								type: "object",
								properties: { name: { type: "string" }, value: { type: "string" } },
							},
						},
					},
				},
				Contact: {
					type: "object",
					properties: {
						id: { type: "string" },
						email: { type: "string", format: "email" },
						first_name: { type: "string", nullable: true },
						last_name: { type: "string", nullable: true },
						unsubscribed: { type: "boolean" },
						properties: { type: "object", additionalProperties: true },
					},
				},
				Company: {
					type: "object",
					properties: {
						id: { type: "string" },
						name: { type: "string" },
						domain: { type: "string", nullable: true },
						plan: { type: "string", nullable: true },
						mrr: { type: "number", nullable: true },
						seats: { type: "integer", nullable: true },
						contacts_count: { type: "integer" },
					},
				},
			},
		},
		paths: {
			"/status": {
				get: {
					tags: ["Status"],
					summary: "Check sending readiness & domain health",
					responses: { "200": { description: "Sending status per brand" } },
				},
			},
			"/stats": {
				get: {
					tags: ["Status"],
					summary: "Daily sending metrics & provider breakdown",
					parameters: [
						{ name: "days", in: "query", schema: { type: "integer", default: 30 } },
					],
					responses: {
						"200": { description: "Daily counts and bounce/complaint rates" },
					},
				},
			},
			"/emails": {
				post: {
					tags: ["Emails"],
					summary: "Send or schedule a transactional email",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/SendEmailRequest" },
							},
						},
					},
					responses: {
						"200": { description: "Queued or sent email id" },
						"422": { description: "Validation error" },
					},
				},
				get: {
					tags: ["Emails"],
					summary: "List sent emails",
					parameters: [
						{ name: "status", in: "query", schema: { type: "string" } },
						{ name: "search", in: "query", schema: { type: "string" } },
						{ name: "limit", in: "query", schema: { type: "integer", default: 20 } },
					],
					responses: { "200": { description: "Email list" } },
				},
			},
			"/emails/batch": {
				post: {
					tags: ["Emails"],
					summary: "Send up to 100 emails in one batch",
					responses: { "200": { description: "Batch queued ids" } },
				},
			},
			"/emails/check": {
				post: {
					tags: ["Deliverability"],
					summary: "Run deliverability & spam content checks",
					responses: { "200": { description: "List of content findings" } },
				},
			},
			"/emails/{id}": {
				get: {
					tags: ["Emails"],
					summary: "Get one email with full event timeline",
					parameters: [
						{ name: "id", in: "path", required: true, schema: { type: "string" } },
					],
					responses: { "200": { description: "Email details" } },
				},
			},
			"/templates": {
				get: {
					tags: ["Templates"],
					summary: "List email templates",
					responses: { "200": { description: "Templates list" } },
				},
				post: {
					tags: ["Templates"],
					summary: "Create an email template",
					responses: { "200": { description: "Created template" } },
				},
			},
			"/templates/{id}": {
				get: {
					tags: ["Templates"],
					summary: "Get a template by id or alias",
					parameters: [
						{ name: "id", in: "path", required: true, schema: { type: "string" } },
					],
					responses: { "200": { description: "Template details" } },
				},
				patch: {
					tags: ["Templates"],
					summary: "Update a template draft",
					parameters: [
						{ name: "id", in: "path", required: true, schema: { type: "string" } },
					],
					responses: { "200": { description: "Updated template" } },
				},
			},
			"/templates/{id}/publish": {
				post: {
					tags: ["Templates"],
					summary: "Publish the template draft",
					parameters: [
						{ name: "id", in: "path", required: true, schema: { type: "string" } },
					],
					responses: { "200": { description: "Published" } },
				},
			},
			"/contacts": {
				get: {
					tags: ["Contacts"],
					summary: "List contacts",
					responses: { "200": { description: "Contact list" } },
				},
				post: {
					tags: ["Contacts"],
					summary: "Create or update a contact",
					responses: { "200": { description: "Upserted contact" } },
				},
			},
			"/companies": {
				get: {
					tags: ["Companies"],
					summary: "List B2B companies / accounts",
					responses: { "200": { description: "Company list" } },
				},
				post: {
					tags: ["Companies"],
					summary: "Create or update a B2B company (auto-links contacts by domain)",
					responses: { "200": { description: "Upserted company" } },
				},
			},
			"/events": {
				post: {
					tags: ["Automations"],
					summary: "Track a contact event and trigger matching automations",
					responses: { "200": { description: "Event recorded" } },
				},
			},
			"/broadcasts": {
				get: {
					tags: ["Broadcasts"],
					summary: "List broadcasts",
					responses: { "200": { description: "Broadcast list" } },
				},
				post: {
					tags: ["Broadcasts"],
					summary: "Create a broadcast draft or schedule it",
					responses: { "200": { description: "Created broadcast" } },
				},
			},
			"/inboxes/conversations": {
				get: {
					tags: ["Inbox"],
					summary: "List shared inbox conversations (email + website chat)",
					responses: { "200": { description: "Conversation list" } },
				},
			},
			"/domains": {
				get: {
					tags: ["Domains"],
					summary: "List verified and pending domains",
					responses: { "200": { description: "Domains list" } },
				},
				post: {
					tags: ["Domains"],
					summary: "Add a sending/receiving domain",
					responses: { "200": { description: "Domain with DNS records" } },
				},
			},
		},
	};
}
