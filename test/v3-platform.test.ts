import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addKnowledgeSource,
	chunkText,
	deleteAiAction,
	deleteKnowledgeSource,
	executeAiAction,
	htmlToPlainText,
	saveAiAction,
	searchKnowledgeChunks,
} from "../src/server/ai-knowledge";
import { isPrivateWebhookHost } from "../src/server/automations";
import { handleChat } from "../src/server/chat-public";
import { upsertCompany } from "../src/server/companies";
import { upsertContact } from "../src/server/contacts";
import { getConversation, sendReply } from "../src/server/conversations";
import { db, schema } from "../src/server/db";
import { PLATFORM_TOOLS } from "../src/server/mcp/tools-platform";
import {
	handleTelegramWebhook,
	handleWhatsAppWebhook,
	listOmnichannelSettings,
	saveTelegramSettings,
	saveWhatsAppSettings,
	sendOmnichannelReply,
} from "../src/server/omnichannel";
import { handlePortalPage, issuePortalLink } from "../src/server/portal";
import { inPublicScope } from "../src/server/public-host";
import {
	activeOutageBanner,
	createStatusIncident,
	getStatusPageData,
	handleStatusPage,
	postIncidentUpdate,
	savePublicPagesSettings,
	saveStatusComponent,
} from "../src/server/status-page";
import { iso } from "../src/server/time";
import { checkDomainWarmup, saveDomainWarmup, warmupDayLimit } from "../src/server/warmup";
import { seedOrg, uid } from "./helpers";

async function hmacHex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Mailroom 3.0 platform", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("omnichannel inbox (WhatsApp Cloud API & Telegram Bot)", () => {
		it("verifies Meta handshake, ingests signed WhatsApp messages, and sends outbound replies", async () => {
			const org = await seedOrg();
			const appSecret = `wa_sec_${uid()}`;
			const verifyToken = `vt_${uid()}`;
			await saveWhatsAppSettings(org.id, {
				phone_number_id: "100200300",
				verify_token: verifyToken,
				app_secret: appSecret,
				access_token: "EAAG_test_access_token_12345",
			});

			// GET Meta hub.challenge verification
			const handshake = await handleWhatsAppWebhook(
				org.id,
				new Request(
					`https://mail.test/hooks/whatsapp/${org.id}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=chal_999`,
				),
			);
			expect(handshake.status).toBe(200);
			expect(await handshake.text()).toBe("chal_999");

			// POST signed inbound WhatsApp message
			const payload = JSON.stringify({
				entry: [
					{
						changes: [
							{
								value: {
									contacts: [
										{ wa_id: "5215512345678", profile: { name: "Sofia" } },
									],
									messages: [
										{
											from: "5215512345678",
											type: "text",
											text: { body: "Hola! Need help with my plan." },
										},
									],
								},
							},
						],
					},
				],
			});
			const sig = `sha256=${await hmacHex(appSecret, payload)}`;
			const res = await handleWhatsAppWebhook(
				org.id,
				new Request(`https://mail.test/hooks/whatsapp/${org.id}`, {
					method: "POST",
					headers: { "x-hub-signature-256": sig },
					body: payload,
				}),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, ingested: 1 });

			const conv = await db
				.select()
				.from(schema.conversations)
				.where(eq(schema.conversations.contact_address, "wa:5215512345678"))
				.get();
			expect(conv?.channel).toBe("whatsapp");
			expect(conv?.messages).toBe(1);
			expect(conv?.visitor_context?.external_phone).toBe("5215512345678");

			// listOmnichannelSettings must not expose plaintext verify_token
			const omniSettings = await listOmnichannelSettings(org.id);
			expect("verify_token" in omniSettings.whatsapp).toBe(false);
			expect(omniSettings.whatsapp.verify_token_hint).toBeTruthy();

			// Reading via Inbox API exposes channel="whatsapp", visitor context, and chat timeline
			if (!conv) throw new Error("Expected WhatsApp conversation");
			const actor = {
				type: "person" as const,
				id: `usr_${uid()}`,
				name: "Support Agent",
				organizationId: org.id,
				brands: [org.id],
				inboxIds: null,
				sendScope: "anyone" as const,
				permissions: new Set(["read", "triage", "notes", "draft", "send"] as const),
				reader: `user:usr_${uid()}`,
				masked: false,
			};
			const fullConv = await getConversation(actor, conv.id, { markRead: false });
			expect(fullConv.channel).toBe("whatsapp");
			expect(fullConv.visitor?.context?.external_phone).toBe("5215512345678");
			expect(
				fullConv.timeline.some((t) => t.type === "chat" && t.text.includes("Hola!")),
			).toBe(true);

			// Replying via conversations.sendReply routes through teamSays -> WhatsApp Cloud API!
			const spy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(Response.json({ messages: [{ id: "wamid.1" }] }));
			await sendReply(
				actor,
				conv.id,
				{ text: "Hi Sofia! Happy to help." },
				{
					dashboard: true,
					send: async () => {
						throw new Error("Omnichannel reply must not use email sender");
					},
				},
			);
			expect(spy).toHaveBeenCalledOnce();
			expect(String(spy.mock.calls[0]?.[0])).toContain("graph.facebook.com");
		});

		it("verifies Telegram secret token, ingests messages, and sends outbound replies", async () => {
			const org = await seedOrg();
			const tgSecret = `tg_sec_${uid()}`;
			await saveTelegramSettings(org.id, {
				bot_username: "@AcmeBot",
				bot_token: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
				secret_token: tgSecret,
			});

			// Reject invalid secret token
			const bad = await handleTelegramWebhook(
				org.id,
				new Request(`https://mail.test/hooks/telegram/${org.id}`, {
					method: "POST",
					headers: { "x-telegram-bot-api-secret-token": "wrong" },
					body: JSON.stringify({}),
				}),
			);
			expect(bad.status).toBe(401);

			const ok = await handleTelegramWebhook(
				org.id,
				new Request(`https://mail.test/hooks/telegram/${org.id}`, {
					method: "POST",
					headers: { "x-telegram-bot-api-secret-token": tgSecret },
					body: JSON.stringify({
						message: {
							text: "Can I upgrade to annual billing?",
							chat: { id: 987654 },
							from: { first_name: "Diego", username: "diegodev" },
						},
					}),
				}),
			);
			expect(ok.status).toBe(200);
			const json = (await ok.json()) as { ok: boolean; conversation_id: string };
			expect(json.ok).toBe(true);

			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ok: true }));
			const replied = await sendOmnichannelReply(
				org.id,
				"telegram",
				{ external_channel: "telegram", external_chat_id: "987654" },
				"tg:987654",
				"Sure thing Diego!",
			);
			expect(replied).toBe(true);
		});
	});

	describe("AI Agent 2.0: knowledge sources & custom HTTP actions", () => {
		it("chunks Markdown & crawled docs, retrieves relevant passages, and runs SSRF-guarded HTTP actions", async () => {
			const org = await seedOrg();
			const plain = htmlToPlainText(
				"<html><head><title>Pricing</title></head><body><h1>Pro Plan</h1><p>Pro costs $49/month with unlimited seats.</p></body></html>",
			);
			expect(plain.title).toBe("Pricing");
			expect(plain.text).toContain("$49/month");
			expect(chunkText("a ".repeat(600), 300, 50).length).toBeGreaterThan(2);

			const src = await addKnowledgeSource(org.id, {
				kind: "markdown",
				title: "Refund Policy",
				content:
					"All annual plans include a full 30-day money-back guarantee. Contact billing@acme.io for refunds.",
			});
			expect(src?.chunks_count).toBe(1);

			const hits = await searchKnowledgeChunks(org.id, "What is your refund guarantee?");
			expect(hits.length).toBe(1);
			expect(hits[0]?.content).toContain("30-day money-back guarantee");

			// Empty / punctuation-only queries return [] rather than arbitrary chunks
			expect(await searchKnowledgeChunks(org.id, "???")).toEqual([]);

			// Unicode / diacritic search works (Spanish)
			const esSrc = await addKnowledgeSource(org.id, {
				kind: "markdown",
				title: "Facturación",
				content: "Emitimos facturas CFDI automáticamente cada mes.",
			});
			const esHits = await searchKnowledgeChunks(org.id, "como obtener facturacion?");
			expect(esHits.length).toBe(1);

			// SSRF checks block CGNAT, 0/8, IPv4-mapped IPv6, and redirect to private host
			expect(isPrivateWebhookHost("http://100.64.0.1/x")).toBe(true);
			expect(isPrivateWebhookHost("http://0.0.0.0/x")).toBe(true);
			expect(isPrivateWebhookHost("http://[::ffff:127.0.0.1]/x")).toBe(true);
			expect(isPrivateWebhookHost("http://[::ffff:7f00:1]/x")).toBe(true);
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1/secret" },
				}),
			);
			await expect(
				addKnowledgeSource(org.id, {
					kind: "url",
					title: "Redirected",
					url: "https://docs.public.example/start",
				}),
			).rejects.toThrow(/private/i);

			// Action URL cannot contain placeholders in the hostname
			await expect(
				saveAiAction(org.id, {
					name: "bad_host",
					description: "Dynamic host must be rejected",
					method: "GET",
					url: "https://{{host}}/orders",
				}),
			).rejects.toThrow(/hostname/i);

			// Custom HTTP Action
			const act = await saveAiAction(org.id, {
				name: "lookup_order",
				description: "Look up order status by order id",
				method: "GET",
				url: "https://api.store.example/orders/{{order_id}}",
				headers: { Authorization: "Bearer secret_123" },
			});
			expect(act.has_headers).toBe(true);

			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				Response.json({ id: "ord_42", status: "shipped" }),
			);
			const out = await executeAiAction(org.id, "lookup_order", { order_id: "ord_42" });
			expect(out.status).toBe(200);
			expect(out.body).toContain("shipped");

			await deleteAiAction(org.id, act.id);
			if (src) await deleteKnowledgeSource(org.id, src.id);
			if (esSrc) await deleteKnowledgeSource(org.id, esSrc.id);
		});
	});

	describe("public Status Page & live Chat Widget outage banner", () => {
		it("requires opt-in, scopes custom domains, strips internal fields, and surfaces active incident banner", async () => {
			const org = await seedOrg();
			const comp = await saveStatusComponent(org.id, {
				name: "Sending API",
				description: "Transactional email endpoints",
				status: "operational",
			});
			const inc = await createStatusIncident(org.id, {
				title: "Elevated SMTP queue latency",
				impact: "minor",
				status: "investigating",
				message: "We are investigating elevated queue latency in us-east-1.",
				component_ids: [comp.id],
				component_status: "degraded",
			});

			// Disabled by default (opt-in required)
			const disabledRes = await handleStatusPage(
				new Request(`https://mail.test/status/${org.slug}`),
			);
			expect(disabledRes.status).toBe(404);

			await savePublicPagesSettings(org.id, { status_page_enabled: true });

			// Raw org ID is rejected (slug only)
			const byIdRes = await handleStatusPage(
				new Request(`https://mail.test/status/${org.id}`),
			);
			expect(byIdRes.status).toBe(404);

			// Another org's custom domain cannot serve this org's status page
			const wrongHostRes = await inPublicScope(
				{
					base: "https://links.other.example",
					organizationId: "other_org",
					domain: "other.example",
				},
				() =>
					handleStatusPage(new Request(`https://links.other.example/status/${org.slug}`)),
			);
			expect(wrongHostRes.status).toBe(404);

			const banner = await activeOutageBanner(org.id);
			expect(banner?.title).toBe("Elevated SMTP queue latency");

			const page = await handleStatusPage(
				new Request(`https://mail.test/status/${org.slug}`),
			);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("Degraded Performance");

			const jsonRes = await handleStatusPage(
				new Request(`https://mail.test/status/${org.slug}/status.json`),
			);
			const statusJson = (await jsonRes.json()) as {
				status: string;
				active_incidents: Record<string, unknown>[];
			};
			expect(statusJson.status).toBe("degraded");
			expect(statusJson.active_incidents).toHaveLength(1);
			// Internal fields must never leak in status.json
			expect(statusJson.active_incidents[0]?.organization_id).toBeUndefined();
			expect(statusJson.active_incidents[0]?.component_ids).toBeUndefined();

			const rssRes = await handleStatusPage(
				new Request(`https://mail.test/status/${org.slug}/feed.xml`),
			);
			expect(rssRes.headers.get("content-type")).toContain("application/rss+xml");

			// Verify chat widget /updates returns active_incident automatically
			const widgetKey = `mrc_${uid()
				.replace(/[^a-zA-Z0-9]/g, "")
				.padEnd(24, "b")
				.slice(0, 24)}`;
			const inboxId = `inb_${uid()}`;
			const now = iso();
			await db.insert(schema.inboxes).values({
				id: inboxId,
				organization_id: org.id,
				name: "Support",
				address: `support@${org.domain}`,
				created_at: now,
				updated_at: now,
			});
			await db.insert(schema.chatWidgets).values({
				inbox_id: inboxId,
				organization_id: org.id,
				public_key: widgetKey,
				enabled: true,
				origins: ["mail.test"],
				design: { title: "Support" },
				notify: [],
				created_at: now,
				updated_at: now,
			});
			const updRes = await handleChat(
				new Request(`https://mail.test/chat/${widgetKey}/updates`, {
					headers: { origin: "https://mail.test" },
				}),
			);
			const updJson = (await updRes.json()) as { active_incident: { title: string } | null };
			expect(updJson.active_incident?.title).toBe("Elevated SMTP queue latency");

			// Resolving incident restores operational state and clears banner
			expect(inc).toBeTruthy();
			if (inc) {
				await postIncidentUpdate(org.id, {
					incident_id: inc.id,
					status: "resolved",
					message: "Queue latency is back to normal.",
				});
			}
			expect(await activeOutageBanner(org.id)).toBeNull();
			expect((await getStatusPageData(org.id)).overall).toBe("operational");
		});
	});

	describe("B2B Customer Support Portal (/portal/<slug>)", () => {
		it("requires opt-in, enforces single-use Secure magic links, exposes B2B company tickets, and makes portal replies visible in inbox", async () => {
			const org = await seedOrg();
			await upsertContact(org.id, { email: "alice@acme.io", first_name: "Alice" });
			await upsertContact(org.id, { email: "bob@acme.io", first_name: "Bob" });
			await upsertCompany(org.id, { name: "Acme", domain: "acme.io", plan: "Enterprise" });

			// Disabled by default (opt-in required)
			const disabled = await handlePortalPage(
				new Request(`https://mail.test/portal/${org.slug}`),
			);
			expect(disabled.status).toBe(404);
			await savePublicPagesSettings(org.id, { portal_enabled: true });

			const convId = `conv_${uid()}`;
			const now = iso();
			await db.insert(schema.conversations).values({
				id: convId,
				organization_id: org.id,
				channel: "email",
				subject: "SSO SAML metadata question",
				contact: "Bob <bob@acme.io>",
				contact_address: "bob@acme.io",
				status: "open",
				snippet: "Where do we upload the IdP cert?",
				last_message_at: now,
				created_at: now,
				updated_at: now,
			});

			const magic = await issuePortalLink(org.id, org.slug, "alice@acme.io", {
				sendEmail: false,
			});
			expect(magic.company_id).toBeTruthy();

			// Exchange single-use ?token=... for a separate HttpOnly; Secure; SameSite=Lax session cookie
			const loginRes = await handlePortalPage(new Request(magic.link));
			expect(loginRes.status).toBe(302);
			const setCookie = loginRes.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("Secure");
			expect(setCookie).toContain("SameSite=Lax");
			const cookie = setCookie.split(";")[0] ?? "";
			expect(cookie).toContain("mr_portal_");
			expect(cookie).not.toContain(magic.token);

			// Replaying the same magic link fails (single-use)
			const replayRes = await handlePortalPage(new Request(magic.link));
			expect(await replayRes.text()).toContain("expired or already used");

			// Alice sees teammate Bob's ticket via Company view!
			const listRes = await handlePortalPage(
				new Request(`https://mail.test/portal/${org.slug}`, { headers: { cookie } }),
			);
			expect(listRes.status).toBe(200);
			const listHtml = await listRes.text();
			expect(listHtml).toContain("SSO SAML metadata question");
			expect(listHtml).toContain("Company view enabled");

			// Alice replies to Bob's email ticket from the portal -> visible in Inbox timeline!
			const fd = new FormData();
			fd.set("message", "Adding our IdP cert details here.");
			const replyRes = await handlePortalPage(
				new Request(`https://mail.test/portal/${org.slug}/t/${convId}/reply`, {
					method: "POST",
					headers: { cookie },
					body: fd,
				}),
			);
			expect(replyRes.status).toBe(302);

			const actor = {
				type: "person" as const,
				id: `usr_${uid()}`,
				name: "Support Agent",
				organizationId: org.id,
				brands: [org.id],
				inboxIds: null,
				sendScope: "anyone" as const,
				permissions: new Set(["read", "triage", "notes", "draft", "send"] as const),
				reader: `user:usr_${uid()}`,
				masked: false,
			};
			const viewed = await getConversation(actor, convId, { markRead: false });
			expect(
				viewed.timeline.some(
					(t) => t.type === "chat" && t.text.includes("IdP cert details"),
				),
			).toBe(true);
		});
	});

	describe("automated domain warm-up ramp & MCP v3 tools", () => {
		it("counts only actually-sent emails on exact domain and blocks sending past the daily limit", async () => {
			const org = await seedOrg();
			const startMs = Date.parse("2026-11-25T12:00:00Z");
			const saved = await saveDomainWarmup(
				org.id,
				org.domainId,
				{
					enabled: true,
					start_date: "2026-11-25",
					daily_start: 10,
					daily_max: 1000,
					ramp_days: 10,
				},
				startMs,
			);
			expect(saved.schedule).toHaveLength(10);
			expect(warmupDayLimit(saved.warmup, startMs).limit).toBe(10);
			expect(warmupDayLimit(saved.warmup, startMs + 9 * 86_400_000).completed).toBe(true);

			// Queued (unsent) emails and other-domain emails must NOT count against today's cap
			const at = iso(startMs);
			for (let i = 0; i < 12; i++) {
				await db.insert(schema.emails).values({
					id: `em_q_${uid()}`,
					organization_id: org.id,
					from: `news@${org.domain}`,
					to: ["a@example.com"],
					subject: "Queued",
					status: "queued",
					created_at: at,
					sent_at: null,
				});
			}
			const allowQueued = await checkDomainWarmup(org.id, org.domain, saved.warmup, startMs);
			expect(allowQueued.allowed).toBe(true);
			expect(allowQueued.sent_today).toBe(0);

			// Actually-sent emails today (by sent_at) DO enforce the daily cap
			for (let i = 0; i < 10; i++) {
				await db.insert(schema.emails).values({
					id: `em_s_${uid()}`,
					organization_id: org.id,
					from: `Hello <hello@${org.domain}>`,
					to: ["b@example.com"],
					subject: "Sent",
					status: "sent",
					created_at: iso(startMs - 86_400_000),
					sent_at: at,
				});
			}
			const blocked = await checkDomainWarmup(org.id, org.domain, saved.warmup, startMs);
			expect(blocked.allowed).toBe(false);
			expect(blocked.sent_today).toBe(10);

			// Verify all new v3 MCP tools are registered
			const names = PLATFORM_TOOLS.map((t) => t.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"list_knowledge_sources",
					"add_knowledge_source",
					"list_ai_actions",
					"save_ai_action",
					"get_status_page",
					"save_public_pages_settings",
					"delete_status_component",
					"create_status_incident",
					"list_omnichannel_settings",
					"save_domain_warmup",
				]),
			);
		});
	});
});
