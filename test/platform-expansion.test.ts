import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mailroom, MailroomError } from "../sdk/index";
import { RECIPES } from "../src/lib/automation-recipes";
import { handleApi } from "../src/server/api";
import { createKey } from "../src/server/api-keys";
import {
	deleteBillingConnector,
	handleBillingWebhook,
	listBillingConnectors,
	saveBillingConnector,
} from "../src/server/billing-connectors";
import { handleChat } from "../src/server/chat-public";
import {
	companyForEmail,
	deleteCompany,
	domainFromEmail,
	getCompany,
	listCompanies,
	upsertCompany,
} from "../src/server/companies";
import { upsertContact } from "../src/server/contacts";
import { db, schema } from "../src/server/db";
import { listArticles } from "../src/server/help-center";
import { importContactsBundle, importHelpArticlesBundle } from "../src/server/importers";
import {
	handleIssueWebhook,
	handleSlackInboundWebhook,
	linkConversationIssue,
	listConversationIssues,
	parseIssueUrl,
	saveOrgWebhookIntegration,
	unlinkConversationIssue,
} from "../src/server/issue-links";
import type { buildOpenApiSpec } from "../src/server/openapi";
import { iso } from "../src/server/time";
import {
	getBrandTransport,
	saveBrandTransport,
	sendViaExternalTransport,
} from "../src/server/transports";
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

describe("platform expansion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("B2B companies", () => {
		it("auto-links contacts by corporate domain, skips free domains, and serves REST endpoints", async () => {
			const org = await seedOrg();
			expect(domainFromEmail("ana@gmail.com")).toBeNull();
			expect(domainFromEmail("ana@acme.io")).toBe("acme.io");

			await upsertContact(org.id, { email: "ana@acme.io", first_name: "Ana" });
			await upsertContact(org.id, { email: "bob@acme.io", first_name: "Bob" });

			const created = await upsertCompany(org.id, {
				name: "Acme Inc",
				domain: "https://www.acme.io/pricing",
				plan: "Enterprise",
				mrr: 2400,
				seats: 18,
			});
			expect(created.domain).toBe("acme.io");
			expect(created.plan).toBe("Enterprise");
			expect(created.mrr).toBe(2400);

			const found = await companyForEmail(org.id, "ana@acme.io");
			expect(found?.id).toBe(created.id);
			expect(found?.contacts_count).toBe(2);

			const detail = await getCompany([org.id], created.id);
			expect(detail.contacts).toHaveLength(2);
			expect((await listCompanies([org.id], { search: "acme" })).length).toBe(1);

			// Also verify public REST API routes (/api/companies)
			const { token } = await createKey({
				organizationId: org.id,
				name: "test-companies",
				permission: "full",
			});
			const listRes = await handleApi(
				new Request("https://mail.test/api/companies?search=acme", {
					headers: { authorization: `Bearer ${token}` },
				}),
			);
			expect(listRes.status).toBe(200);
			const listJson = (await listRes.json()) as { data: { id: string }[] };
			expect(listJson.data[0]?.id).toBe(created.id);

			await deleteCompany([org.id], created.id);
			expect(await companyForEmail(org.id, "ana@acme.io")).toBeNull();
		});
	});

	describe("native billing webhook sync & SaaS automation recipes", () => {
		it("includes dunning, trial_ending, and churn_winback SaaS recipes", () => {
			const ids = RECIPES.map((r) => r.id);
			expect(ids).toContain("dunning");
			expect(ids).toContain("trial_ending");
			expect(ids).toContain("churn_winback");
		});

		it("verifies Stripe signatures, rejects bad signatures, and syncs contact + company + event", async () => {
			const org = await seedOrg();
			const secret = `whsec_${uid()}`;
			const connector = await saveBillingConnector(org.id, {
				provider: "stripe",
				name: "Stripe Prod",
				signing_secret: secret,
			});
			expect(connector.secret_hint).toBe(`…${secret.slice(-4)}`);
			expect((await listBillingConnectors([org.id])).length).toBe(1);

			const body = JSON.stringify({
				type: "customer.subscription.created",
				data: {
					object: {
						id: "sub_123",
						customer_email: "ceo@hyperion.dev",
						customer_name: "Elena Vance",
						amount_paid: 49900,
						currency: "usd",
						plan: { nickname: "Scale" },
					},
				},
			});

			// Bad signature -> 401
			const badRes = await handleBillingWebhook(
				connector.id,
				new Request(`https://mail.test/hooks/billing/${connector.id}`, {
					method: "POST",
					headers: { "stripe-signature": "t=1700000000,v1=deadbeef" },
					body,
				}),
			);
			expect(badRes.status).toBe(401);

			// Valid Stripe HMAC-SHA256 signature -> 200
			const ts = Math.floor(Date.now() / 1000);
			const v1 = await hmacHex(secret, `${ts}.${body}`);
			const okRes = await handleBillingWebhook(
				connector.id,
				new Request(`https://mail.test/hooks/billing/${connector.id}`, {
					method: "POST",
					headers: { "stripe-signature": `t=${ts},v1=${v1}` },
					body,
				}),
			);
			expect(okRes.status).toBe(200);
			const okJson = (await okRes.json()) as { received: boolean; event: string };
			expect(okJson.received).toBe(true);
			expect(okJson.event).toBe("billing.subscription_started");

			// Contact & Company were auto-synced
			const company = await companyForEmail(org.id, "ceo@hyperion.dev");
			expect(company?.domain).toBe("hyperion.dev");
			expect(company?.plan).toBe("Scale");
			expect(company?.mrr).toBe(499);

			await deleteBillingConnector([org.id], connector.id);
		});
	});

	describe("GitHub / Linear issue sync & two-way Slack replies", () => {
		it("parses URLs, links issues, auto-reopens conversation on GitHub close, and accepts Slack replies", async () => {
			const org = await seedOrg();
			expect(parseIssueUrl("https://github.com/acme/app/issues/42")).toEqual({
				provider: "github",
				external_id: "acme/app#42",
				defaultTitle: "acme/app #42",
			});
			expect(parseIssueUrl("https://linear.app/acme/issue/ENG-108/fix-sso")).toEqual({
				provider: "linear",
				external_id: "ENG-108",
				defaultTitle: "ENG-108",
			});

			// Seed a closed conversation in the org
			const convId = `conv_${uid()}`;
			const now = iso();
			await db.insert(schema.conversations).values({
				id: convId,
				organization_id: org.id,
				channel: "email",
				subject: "SSO login failing",
				contact: "Sam <sam@acme.io>",
				contact_address: "sam@acme.io",
				status: "closed",
				last_message_at: now,
				created_at: now,
				updated_at: now,
			});

			const link = await linkConversationIssue(org.id, convId, {
				url: "https://github.com/acme/app/issues/42",
				title: "Fix SAML callback",
			});
			expect((await listConversationIssues(convId)).length).toBe(1);

			// Configure GitHub webhook secret and deliver a closed-issue event
			const ghSecret = `ghs_${uid()}`;
			await saveOrgWebhookIntegration(org.id, {
				kind: "github",
				secret: ghSecret,
				enabled: true,
			});
			const ghPayload = JSON.stringify({
				action: "closed",
				repository: { full_name: "acme/app" },
				issue: { number: 42, title: "Fix SAML callback" },
			});
			const ghSig = `sha256=${await hmacHex(ghSecret, ghPayload)}`;
			const ghRes = await handleIssueWebhook(
				org.id,
				"github",
				new Request(`https://mail.test/hooks/issues/${org.id}/github`, {
					method: "POST",
					headers: { "x-hub-signature-256": ghSig },
					body: ghPayload,
				}),
			);
			expect(ghRes.status).toBe(200);
			const ghJson = (await ghRes.json()) as { updated: number };
			expect(ghJson.updated).toBe(1);

			// Conversation was reopened and issue marked closed
			const updatedConv = await db
				.select()
				.from(schema.conversations)
				.where(eq(schema.conversations.id, convId))
				.get();
			expect(updatedConv?.status).toBe("open");
			expect((await listConversationIssues(convId))[0]?.status).toBe("closed");

			// Configure Slack signing secret: verify url_verification & two-way note reply
			const slackSecret = `slk_${uid()}`;
			await saveOrgWebhookIntegration(org.id, {
				kind: "slack",
				secret: slackSecret,
				enabled: true,
			});
			const ts = String(Math.floor(Date.now() / 1000));
			const challengeBody = JSON.stringify({ type: "url_verification", challenge: "ch_xyz" });
			const challengeSig = `v0=${await hmacHex(slackSecret, `v0:${ts}:${challengeBody}`)}`;
			const challengeRes = await handleSlackInboundWebhook(
				org.id,
				new Request(`https://mail.test/hooks/slack/${org.id}`, {
					method: "POST",
					headers: { "x-slack-request-timestamp": ts, "x-slack-signature": challengeSig },
					body: challengeBody,
				}),
			);
			expect(await challengeRes.json()).toEqual({ challenge: "ch_xyz" });

			const replyBody = JSON.stringify({
				type: "event_callback",
				event: { type: "message", user: "U123", text: `${convId}: Shipping fix in 5m!` },
			});
			const replySig = `v0=${await hmacHex(slackSecret, `v0:${ts}:${replyBody}`)}`;
			const replyRes = await handleSlackInboundWebhook(
				org.id,
				new Request(`https://mail.test/hooks/slack/${org.id}`, {
					method: "POST",
					headers: { "x-slack-request-timestamp": ts, "x-slack-signature": replySig },
					body: replyBody,
				}),
			);
			expect(await replyRes.json()).toMatchObject({
				ok: true,
				mode: "note",
				conversation_id: convId,
			});

			await unlinkConversationIssue(convId, link.id);
			expect((await listConversationIssues(convId)).length).toBe(0);
		});
	});

	describe("pluggable transports & one-click migration importers", () => {
		it("routes sends through Resend when configured and returns null for SES", async () => {
			const org = await seedOrg();
			expect(
				await sendViaExternalTransport(org.id, {
					from: `hi@${org.domain}`,
					to: ["u@example.com"],
					subject: "SES default",
					text: "hello",
				}),
			).toBeNull();

			await saveBrandTransport(org.id, {
				provider: "resend",
				api_key: "re_test_123456789",
				enabled: true,
			});
			const row = await getBrandTransport(org.id);
			expect(row?.provider).toBe("resend");

			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				Response.json({ id: "re_msg_999" }, { status: 200 }),
			);
			const id = await sendViaExternalTransport(org.id, {
				from: `hi@${org.domain}`,
				to: ["u@example.com"],
				subject: "Via Resend",
				html: "<p>Hi</p>",
			});
			expect(id).toBe("resend:re_msg_999");

			// Switch back to SES
			await saveBrandTransport(org.id, { provider: "ses" });
			expect(
				await sendViaExternalTransport(org.id, {
					from: `hi@${org.domain}`,
					to: ["u@example.com"],
					subject: "Back to SES",
					text: "hi",
				}),
			).toBeNull();
		});

		it("imports CSV contacts + auto-syncs companies, and imports JSON help articles", async () => {
			const org = await seedOrg();
			const csv = [
				"email,first_name,company,plan",
				"alice@northstar.co,Alice,Northstar,Pro",
				"ben@northstar.co,Ben,Northstar,Pro",
			].join("\n");
			const cRes = await importContactsBundle(org.id, { source: "csv", content: csv });
			expect(cRes.imported).toBe(2);
			expect(cRes.companies_synced).toBe(2);

			const comp = await companyForEmail(org.id, "alice@northstar.co");
			expect(comp?.name).toBe("Northstar");
			expect(comp?.plan).toBe("Pro");

			const hRes = await importHelpArticlesBundle(org.id, {
				publish: true,
				content: JSON.stringify([
					{
						title: "Migrated FAQ",
						category: "Billing",
						body: "<p>Refunds within 30 days.</p>",
					},
				]),
			});
			expect(hRes.imported).toBe(1);
			const arts = await listArticles([org.id], { status: "published" });
			expect(arts.some((a) => a.title === "Migrated FAQ")).toBe(true);
		});
	});

	describe("in-widget changelog newsfeed & reactions", () => {
		it("returns published web broadcasts and increments emoji reactions", async () => {
			const org = await seedOrg();
			const widgetKey = `mrc_${uid()
				.replace(/[^a-zA-Z0-9]/g, "")
				.padEnd(24, "a")
				.slice(0, 24)}`;
			const inboxId = `inb_${uid()}`;
			const bcId = `bc_${uid()}`;
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
			await db.insert(schema.broadcasts).values({
				id: bcId,
				organization_id: org.id,
				name: "Spring Launch",
				from: `hi@${org.domain}`,
				subject: "Introducing B2B Companies",
				preview_text: "Group contacts by account and track MRR.",
				html: "<p>New release!</p>",
				status: "sent",
				web: true,
				completed_at: now,
				created_at: now,
				updated_at: now,
			});

			const listRes = await handleChat(
				new Request(`https://mail.test/chat/${widgetKey}/updates`, {
					headers: { origin: "https://mail.test" },
				}),
			);
			expect(listRes.status).toBe(200);
			const listJson = (await listRes.json()) as {
				updates: { id: string; title: string; reactions: Record<string, number> }[];
			};
			expect(listJson.updates.length).toBe(1);
			expect(listJson.updates[0]?.title).toBe("Introducing B2B Companies");

			const reactRes = await handleChat(
				new Request(`https://mail.test/chat/${widgetKey}/react`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: "https://mail.test" },
					body: JSON.stringify({ id: bcId, emoji: "🎉" }),
				}),
			);
			expect(reactRes.status).toBe(200);

			const afterRes = await handleChat(
				new Request(`https://mail.test/chat/${widgetKey}/updates`, {
					headers: { origin: "https://mail.test" },
				}),
			);
			const afterJson = (await afterRes.json()) as {
				updates: { reactions: Record<string, number> }[];
			};
			expect(afterJson.updates[0]?.reactions["🎉"]).toBe(1);
		});
	});

	describe("OpenAPI 3.1 spec & zero-dep TypeScript SDK", () => {
		it("serves public /api/openapi.json without auth and works with Mailroom SDK", async () => {
			const res = await handleApi(new Request("https://mail.test/api/openapi.json"));
			expect(res.status).toBe(200);
			const spec = (await res.json()) as ReturnType<typeof buildOpenApiSpec>;
			expect(spec.openapi).toBe("3.1.0");
			expect(spec.paths["/emails"]).toBeDefined();
			expect(spec.paths["/companies"]).toBeDefined();

			const calls: { url: string; method?: string; headers?: HeadersInit }[] = [];
			const mr = new Mailroom({
				url: "https://mail.test",
				apiKey: "mr_test_123",
				brand: "acme",
				fetch: async (input, init) => {
					calls.push({
						url: String(input),
						method: init?.method,
						headers: init?.headers,
					});
					if (String(input).includes("/fail")) {
						return Response.json(
							{ name: "validation_error", message: "Bad request" },
							{ status: 422 },
						);
					}
					return Response.json({ id: "cmp_1", name: "Acme" }, { status: 201 });
				},
			});

			const comp = await mr.companies.upsert({ name: "Acme", domain: "acme.io", mrr: 500 });
			expect(comp.id).toBe("cmp_1");
			expect(calls[0]?.url).toBe("https://mail.test/api/companies?brand=acme");

			await expect(mr.request("GET", "/fail")).rejects.toBeInstanceOf(MailroomError);
		});
	});
});
