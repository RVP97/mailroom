import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifestRaw from "../public/manifest.webmanifest?raw";
import { saveAiSettings, triageConversationWithAi } from "../src/server/ai";
import {
	createAutomation,
	isPrivateWebhookHost,
	recordEvent,
	runAutomations,
} from "../src/server/automations";
import { handleChangelogPage } from "../src/server/changelog-public";
import { upsertCompany } from "../src/server/companies";
import { upsertContact } from "../src/server/contacts";
import { db, schema } from "../src/server/db";
import { inboxReport } from "../src/server/inbox-reports";
import type { InboxActor } from "../src/server/inboxes";
import { PLATFORM_TOOLS } from "../src/server/mcp/tools-platform";
import { searchEverything } from "../src/server/search";
import { iso } from "../src/server/time";
import { seedOrg, uid } from "./helpers";

describe("state-of-the-art upgrades", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("automation webhook step (custom method, headers, body & SSRF guard)", () => {
		it("blocks private/localhost hosts", () => {
			expect(isPrivateWebhookHost("https://localhost/hook")).toBe(true);
			expect(isPrivateWebhookHost("https://127.0.0.1:8080/hook")).toBe(true);
			expect(isPrivateWebhookHost("https://169.254.169.254/latest/meta-data")).toBe(true);
			expect(isPrivateWebhookHost("https://10.0.0.5/internal")).toBe(true);
			expect(isPrivateWebhookHost("https://192.168.1.10/api")).toBe(true);
			expect(isPrivateWebhookHost("https://172.16.0.1/api")).toBe(true);
			expect(isPrivateWebhookHost("https://hooks.slack.com/services/T0/B0/XX")).toBe(false);
		});

		it("interpolates custom headers and JSON body on webhook steps", async () => {
			const org = await seedOrg();
			await upsertContact(org.id, { email: "ana@acme.io", first_name: "Ana" });

			await createAutomation(org.id, {
				name: "Notify Slack on failed payment",
				status: "active",
				trigger: { type: "event", event: "billing.payment_failed" },
				steps: [
					{
						type: "webhook",
						url: "https://hooks.example.com/notify",
						method: "PUT",
						headers: {
							"X-Customer": "{{{contact.email}}}",
							Authorization: "Bearer tok_123",
						},
						body: '{"text":"Payment failed for {{{FIRST_NAME}}} ({{{event.plan}}})"}',
					},
				],
			});

			const calls: { url: string; method?: string; headers?: HeadersInit; body?: string }[] =
				[];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				calls.push({
					url: String(input),
					method: init?.method,
					headers: init?.headers,
					body: String(init?.body ?? ""),
				});
				return Response.json({ ok: true });
			});

			const now = Date.now();
			await recordEvent(
				org.id,
				{
					event: "billing.payment_failed",
					email: "ana@acme.io",
					data: { plan: "Enterprise" },
				},
				now,
			);
			await runAutomations(now + 1000);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://hooks.example.com/notify");
			expect(calls[0]?.method).toBe("PUT");
			expect((calls[0]?.headers as Record<string, string>)["X-Customer"]).toBe("ana@acme.io");
			expect(calls[0]?.body).toBe('{"text":"Payment failed for Ana (Enterprise)"}');
		});
	});

	describe("AI Auto-Triage & AI Resolution Analytics", () => {
		it("auto-triages a frustrated conversation, escalates priority, merges tags, and posts an alert note", async () => {
			const org = await seedOrg();
			await saveAiSettings(
				org.id,
				{
					provider: "openai",
					model: "gpt-4o-mini",
					api_key: "sk-test-1234567890",
					copilot_enabled: true,
				},
				"user_admin",
			);

			const convId = `conv_${uid()}`;
			const now = iso();
			await db.insert(schema.conversations).values({
				id: convId,
				organization_id: org.id,
				channel: "email",
				subject: "Charged twice on invoice #99",
				contact: "Liam <liam@kestrel.example>",
				contact_address: "liam@kestrel.example",
				status: "open",
				priority: "normal",
				tags: ["existing"],
				last_message_at: now,
				created_at: now,
				updated_at: now,
			});

			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									priority: "normal",
									sentiment: "frustrated",
									tags: ["billing", "refund"],
									reason: "Customer was double-charged and is upset.",
								}),
							},
						},
					],
				}),
			);

			const actor: InboxActor = {
				organizationId: org.id,
				brands: [org.id],
				inboxIds: null,
				permissions: new Set(["read", "triage", "notes", "send"]),
				sendScope: "replies",
				type: "person",
				id: "user_admin",
				name: "Admin",
				reader: "user:user_admin",
				masked: false,
			};

			const res = await triageConversationWithAi(actor, convId);
			expect(res.sentiment).toBe("frustrated");
			// Frustrated escalates normal -> high
			expect(res.priority).toBe("high");
			expect(res.tags).toEqual(["existing", "billing", "refund"]);

			const updated = await db
				.select()
				.from(schema.conversations)
				.where(eq(schema.conversations.id, convId))
				.get();
			expect(updated?.priority).toBe("high");
			expect(updated?.tags).toEqual(["existing", "billing", "refund"]);

			const notes = await db
				.select()
				.from(schema.conversationNotes)
				.where(eq(schema.conversationNotes.conversation_id, convId));
			expect(notes.some((n) => n.author_name === "AI Triage")).toBe(true);
		});

		it("computes AI deflection rate and estimated Intercom Fin savings in inboxReport", async () => {
			const org = await seedOrg();
			const nowMs = Date.now();
			const at = iso(nowMs);
			const convAi = `conv_${uid()}`;
			const convHuman = `conv_${uid()}`;

			await db.insert(schema.conversations).values([
				{
					id: convAi,
					organization_id: org.id,
					channel: "chat",
					subject: "Reset password",
					contact: "u1@example.com",
					contact_address: "u1@example.com",
					status: "resolved",
					first_reply_at: at,
					resolved_at: at,
					last_message_at: at,
					created_at: at,
					updated_at: at,
				},
				{
					id: convHuman,
					organization_id: org.id,
					channel: "email",
					subject: "Custom enterprise contract",
					contact: "u2@example.com",
					contact_address: "u2@example.com",
					status: "open",
					first_reply_at: at,
					last_message_at: at,
					created_at: at,
					updated_at: at,
				},
			]);

			await db.insert(schema.conversationReplies).values([
				{
					id: `rep_${uid()}`,
					organization_id: org.id,
					conversation_id: convAi,
					to: ["u1@example.com"],
					subject: "Re: Reset password",
					text: "Use the link in Settings.",
					status: "sent",
					author_type: "agent",
					author_id: "ai-assistant",
					author_name: "AI Assistant",
					sent_at: at,
					created_at: at,
					updated_at: at,
				},
				{
					id: `rep_${uid()}`,
					organization_id: org.id,
					conversation_id: convHuman,
					to: ["u2@example.com"],
					subject: "Re: Custom enterprise contract",
					text: "Let's jump on a call.",
					status: "sent",
					author_type: "person",
					author_id: "user_1",
					author_name: "Maya",
					sent_at: at,
					created_at: at,
					updated_at: at,
				},
			]);

			const actor: InboxActor = {
				organizationId: org.id,
				brands: [org.id],
				inboxIds: null,
				permissions: new Set(["read"]),
				sendScope: "replies",
				type: "person",
				id: "user_1",
				name: "Maya",
				reader: "user:user_1",
				masked: false,
			};

			const report = await inboxReport(actor, { now: nowMs });
			expect(report.totals.ai_resolution.deflected).toBe(1);
			expect(report.totals.ai_resolution.deflection_rate).toBe(0.5);
			expect(report.totals.ai_resolution.estimated_fin_savings_usd).toBe(0.99);
		});
	});

	describe("standalone public changelog page, RSS feed & emoji reactions", () => {
		it("serves branded HTML timeline, search filter, RSS 2.0 XML, and persists emoji reactions", async () => {
			const org = await seedOrg();
			const bcId = `bc_${uid()}`;
			const now = iso();
			await db.insert(schema.broadcasts).values({
				id: bcId,
				organization_id: org.id,
				name: "V2 Release",
				from: `hi@${org.domain}`,
				subject: "Introducing Public Changelogs",
				preview_text: "Ship product updates with RSS and emoji reactions.",
				html: "<p>Full details</p>",
				status: "sent",
				web: true,
				completed_at: now,
				created_at: now,
				updated_at: now,
			});

			const pageRes = await handleChangelogPage(
				new Request(`https://mail.test/changelog/${org.slug}`),
			);
			expect(pageRes.status).toBe(200);
			const html = await pageRes.text();
			expect(html).toContain("Introducing Public Changelogs");
			expect(html).toContain(`/changelog/${org.slug}/feed.xml`);

			const searchMiss = await handleChangelogPage(
				new Request(`https://mail.test/changelog/${org.slug}?q=nonexistent`),
			);
			expect(await searchMiss.text()).toContain("No published updates");

			const rssRes = await handleChangelogPage(
				new Request(`https://mail.test/changelog/${org.slug}/feed.xml`),
			);
			expect(rssRes.status).toBe(200);
			expect(rssRes.headers.get("content-type")).toContain("application/rss+xml");
			const xml = await rssRes.text();
			expect(xml).toContain('<rss version="2.0"');
			expect(xml).toContain("<title>Introducing Public Changelogs</title>");

			const reactRes = await handleChangelogPage(
				new Request(`https://mail.test/changelog/${org.slug}/react`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: bcId, emoji: "🔥" }),
				}),
			);
			expect(reactRes.status).toBe(200);
			expect(await reactRes.json()).toEqual({ ok: true, id: bcId, emoji: "🔥", count: 1 });
		});
	});

	describe("MCP parity & installable PWA manifest", () => {
		it("registers platform MCP tools for companies, billing, issues, transports, importers & AI", () => {
			const names = PLATFORM_TOOLS.map((t) => t.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"list_companies",
					"get_company",
					"save_company",
					"delete_company",
					"list_billing_connectors",
					"list_conversation_issues",
					"link_conversation_issue",
					"unlink_conversation_issue",
					"get_brand_transport",
					"import_contacts_bundle",
					"import_help_articles_bundle",
					"ai_triage_conversation",
					"ai_email_copy",
				]),
			);
		});

		it("ships a valid installable PWA webmanifest", () => {
			const manifest = JSON.parse(manifestRaw) as {
				name: string;
				display: string;
				start_url: string;
				shortcuts: { url: string }[];
			};
			expect(manifest.name).toBe("Mailroom");
			expect(manifest.display).toBe("standalone");
			expect(manifest.start_url).toBe("/today");
			expect(manifest.shortcuts.length).toBeGreaterThanOrEqual(2);
		});

		it("indexes B2B companies in ⌘K global search", async () => {
			const org = await seedOrg();
			const cmp = await upsertCompany(org.id, {
				name: "Quantum Dynamics",
				domain: "quantum.example",
				plan: "Enterprise",
				mrr: 3500,
			});
			const actor: InboxActor = {
				organizationId: org.id,
				brands: [org.id],
				inboxIds: null,
				permissions: new Set(["read"]),
				sendScope: "replies",
				type: "person",
				id: "user_1",
				name: "Admin",
				reader: "user:user_1",
				masked: false,
			};
			const res = await searchEverything({
				organizationId: org.id,
				brands: [org.id],
				actor,
				q: "quantum",
				names: new Map([[org.id, "Test"]]),
				masked: false,
				kinds: ["company"],
			});
			expect(res.hits).toHaveLength(1);
			expect(res.hits[0]?.id).toBe(cmp.id);
			expect(res.hits[0]?.path).toBe(`/companies/${cmp.id}`);
		});
	});
});
