import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error untyped ESM CLI helper module
import { createDevHandler, pullTemplates, pushTemplates } from "../cli/dev-and-sync.mjs";
import {
	DEFAULT_THEME,
	type EmailDoc,
	evaluateBlockCondition,
	hasBlockConditions,
	parseDoc,
	renderEmail,
} from "../src/lib/email-doc";
import { importMarkupToEmailDoc } from "../src/lib/email-import";
import { db, schema } from "../src/server/db";
import {
	createArticle,
	localizeArticle,
	saveHelpCenter,
	searchArticles,
	updateArticle,
} from "../src/server/help-center";
import {
	applyMacro,
	deleteInboxView,
	deleteMacro,
	listInboxViews,
	listMacros,
	saveInboxView,
	saveMacro,
} from "../src/server/inbox-power";
import { memberActor } from "../src/server/inboxes";
import {
	deleteAlertChannel,
	detectAlertKind,
	dispatchTeamAlert,
	formatChannelPayload,
	listAlertChannels,
	saveAlertChannel,
} from "../src/server/team-alerts";
import { fakeOutside, seedOrg } from "./helpers";

describe("Next-wave upgrades", () => {
	it("creates, encrypts, formats, and dispatches Slack & Discord team alert channels", async () => {
		fakeOutside();
		const org = await seedOrg();

		expect(detectAlertKind("https://hooks.slack.com/services/T0/B0/XYZ")).toBe("slack");
		expect(detectAlertKind("https://discord.com/api/webhooks/123/abc")).toBe("discord");
		expect(detectAlertKind("https://alerts.example.com/hook")).toBe("webhook");

		await expect(
			saveAlertChannel(org.id, {
				name: "Bad",
				webhook_url: "http://127.0.0.1:8080/hook",
				events: ["chat.started"],
			}),
		).rejects.toThrow(/private or local/i);

		const ch = await saveAlertChannel(org.id, {
			name: "#support",
			webhook_url: "https://hooks.slack.com/services/T000/B000/SECRET99",
			events: ["chat.started", "sla.breached"],
		});
		expect(ch.kind).toBe("slack");
		expect(ch.url_hint).toContain("hooks.slack.com");
		expect(ch.url_hint).not.toContain("SECRET99");

		const slackPayload = formatChannelPayload(
			"slack",
			"sla.breached",
			{
				title: "SLA overdue",
				body: "Reply overdue for Ana",
				fields: [{ label: "Contact", value: "ana@example.com" }],
				severity: "danger",
			},
			"https://mailroom.example.com/received/c1",
		);
		expect(slackPayload).toHaveProperty("blocks");

		const discordPayload = formatChannelPayload(
			"discord",
			"chat.started",
			{ title: "New chat", body: "Hello!", severity: "info" },
			null,
		);
		expect(discordPayload).toHaveProperty("embeds");

		const calls: { url: string; body: string }[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			calls.push({ url: String(input), body: String(init?.body ?? "") });
			return new Response("ok", { status: 200 });
		});
		try {
			const sent = await dispatchTeamAlert(org.id, "chat.started", {
				title: "New live chat from Ana",
				body: "Need help with invoice",
				path: "/received/c1",
			});
			expect(sent).toBe(1);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T000/B000/SECRET99");

			const skipped = await dispatchTeamAlert(org.id, "sending.alert", {
				title: "Ignored",
			});
			expect(skipped).toBe(0);
		} finally {
			spy.mockRestore();
		}

		const list = await listAlertChannels(org.id);
		expect(list).toHaveLength(1);
		expect(list[0]?.last_sent_at).toBeTruthy();

		await deleteAlertChannel(org.id, ch.id);
		expect(await listAlertChannels(org.id)).toHaveLength(0);
	});

	it("runs multi-action Inbox macros and manages shared/personal saved views", async () => {
		fakeOutside();
		const org = await seedOrg();
		const now = new Date().toISOString();
		const convId = "conv_macro_test";
		await db.insert(schema.conversations).values({
			id: convId,
			organization_id: org.id,
			inbox_id: null,
			channel: "email",
			contact: "Ana Lopez <ana@example.com>",
			contact_address: "ana@example.com",
			subject: "Refund request",
			status: "open",
			priority: "normal",
			created_at: now,
			updated_at: now,
			last_message_at: now,
			last_inbound_at: now,
		});

		const macro = await saveMacro(org.id, {
			name: "Approve refund",
			shortcut: "refund",
			reply_text: "Hi {{contact.first_name}}, refund approved by {{agent.name}}!",
			note_text: "Processed via billing macro",
			actions: {
				add_tags: ["billing", "refund"],
				priority: "high",
				status: "resolved",
			},
		});
		expect(await listMacros([org.id])).toHaveLength(1);

		const actor = memberActor({
			organizationId: org.id,
			brands: [org.id],
			userId: "user_1",
			name: "Rodrigo",
			canReply: true,
			masked: false,
		});
		const applied = await applyMacro(actor, convId, macro.id);
		expect(applied.reply_text).toContain("Ana");
		expect(applied.reply_text).toContain("Rodrigo");
		expect(applied.applied).toContain("priority:high");
		expect(applied.applied).toContain("status:resolved");
		expect(applied.macro.uses).toBe(1);

		await deleteMacro([org.id], macro.id);
		expect(await listMacros([org.id])).toHaveLength(0);

		const shared = await saveInboxView(
			org.id,
			{ name: "VIP Urgent", filters: { priority: "urgent", tag: "vip" }, shared: true },
			"user_1",
		);
		const personal = await saveInboxView(
			org.id,
			{ name: "My drafts", filters: { q: "draft" }, shared: false },
			"user_1",
		);
		expect(await listInboxViews(org.id, "user_1")).toHaveLength(2);
		expect(await listInboxViews(org.id, "user_2")).toHaveLength(1);
		await deleteInboxView(org.id, personal.id, "user_1");
		await deleteInboxView(org.id, shared.id, "user_1");
		expect(await listInboxViews(org.id, "user_1")).toHaveLength(0);
	});

	it("evaluates conditional email blocks and imports MJML & HTML into editable blocks", () => {
		expect(
			evaluateBlockCondition(
				{ field: "plan", op: "eq", value: "pro" },
				{ values: { "contact.plan": "Pro" } },
			),
		).toBe(true);
		expect(
			evaluateBlockCondition(
				{ field: "segment", op: "eq", value: "vip" },
				{ segments: ["VIP"] },
			),
		).toBe(true);

		const rawDoc: EmailDoc = {
			version: 1,
			theme: DEFAULT_THEME,
			blocks: [
				{ id: "b1", type: "heading", level: 1, html: "Hello", align: "left" },
				{
					id: "b2",
					type: "text",
					html: "<p>PRO-ONLY PERK</p>",
					align: "left",
					show_if: { field: "plan", op: "eq", value: "pro" },
				},
				{
					id: "b3",
					type: "text",
					html: "<p>UPGRADE NOW</p>",
					align: "left",
					show_if: { field: "plan", op: "neq", value: "pro" },
				},
			],
		};
		const parsed = parseDoc(rawDoc);
		expect(parsed).not.toBeNull();
		expect(hasBlockConditions(parsed)).toBe(true);

		const proHtml = renderEmail(parsed as EmailDoc, {
			context: { values: { "contact.plan": "pro" } },
		});
		expect(proHtml).toContain("PRO-ONLY PERK");
		expect(proHtml).not.toContain("UPGRADE NOW");

		const freeHtml = renderEmail(parsed as EmailDoc, {
			context: { values: { "contact.plan": "free" } },
		});
		expect(freeHtml).not.toContain("PRO-ONLY PERK");
		expect(freeHtml).toContain("UPGRADE NOW");

		const mjml = importMarkupToEmailDoc(
			`<mjml><mj-body><mj-section><mj-column><mj-text><h1>Welcome</h1></mj-text><mj-text>Thanks for joining.</mj-text><mj-button href="https://example.com" background-color="#2563eb">Open app</mj-button><mj-divider /></mj-column></mj-section></mj-body></mjml>`,
		);
		expect(mjml.format).toBe("mjml");
		expect(mjml.doc.blocks.map((b) => b.type)).toEqual([
			"heading",
			"text",
			"button",
			"divider",
		]);

		const html = importMarkupToEmailDoc(
			`<html><body><h2>Monthly update</h2><p>Here is what shipped.</p><p><a href="https://example.com" style="background:#111;padding:12px 20px;color:#fff">Read changelog</a></p><hr></body></html>`,
		);
		expect(html.format).toBe("html");
		expect(html.doc.blocks.map((b) => b.type)).toEqual([
			"heading",
			"text",
			"button",
			"divider",
		]);
	});

	it("stores and searches localized Help Center articles", async () => {
		fakeOutside();
		const org = await seedOrg();
		await saveHelpCenter(org.id, { title: "Acme Help", enabled: true });

		const art = await createArticle(org.id, {
			title: "How to cancel my booking",
			description: "Cancel anytime up to 24 hours before check-in.",
			html: "<p>Open your confirmation email and click Cancel.</p>",
			status: "published",
			locale: "en",
			translations: {
				es: {
					title: "Cómo cancelar mi reservación",
					description: "Cancela hasta 24 horas antes del check-in.",
					html: "<p>Abre tu correo de confirmación y haz clic en Cancelar.</p>",
				},
			},
		});

		const esView = localizeArticle(art, "es");
		expect(esView.title).toBe("Cómo cancelar mi reservación");
		expect(esView.html).toContain("Cancelar");

		const fallbackView = localizeArticle(art, "fr");
		expect(fallbackView.title).toBe("How to cancel my booking");

		const searchEs = await searchArticles(org.id, "cancelar reservacion", { lang: "es" });
		expect(searchEs.results).toHaveLength(1);
		expect(searchEs.results[0]?.title).toBe("Cómo cancelar mi reservación");

		const updated = await updateArticle(org.id, art.id, { translations: { es: null } });
		expect(updated.translations).toBeNull();
	});

	it("supports CLI template pull/push sync and the local dev email catcher server", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mailroom-cli-"));
		try {
			const remote = [
				{
					id: "tpl_1",
					name: "Welcome",
					alias: "welcome",
					subject: "Welcome!",
					html: "<h1>Hi</h1>",
					variables: [],
				},
			];
			const patched: unknown[] = [];
			const created: unknown[] = [];
			const fakeApi = async (method: string, path: string, body?: unknown) => {
				if (method === "GET" && path === "/templates") return { data: remote };
				if (method === "GET" && path === "/templates/tpl_1") return remote[0];
				if (method === "PATCH" && path === "/templates/tpl_1") {
					patched.push(body);
					return { id: "tpl_1" };
				}
				if (method === "POST" && path === "/templates") {
					created.push(body);
					return { id: "tpl_new" };
				}
				if (method === "POST" && path.endsWith("/publish")) return { ok: true };
				throw new Error(`Unexpected ${method} ${path}`);
			};

			const pulled = await pullTemplates(fakeApi, dir);
			expect(pulled.count).toBe(1);
			expect(await readFile(join(dir, "welcome.html"), "utf8")).toBe("<h1>Hi</h1>");

			await writeFile(join(dir, "welcome.html"), "<h1>Hi updated</h1>", "utf8");
			await writeFile(
				join(dir, "reset.json"),
				JSON.stringify({ name: "Reset", alias: "reset", subject: "Reset password" }),
				"utf8",
			);
			await writeFile(join(dir, "reset.html"), "<p>Reset link</p>", "utf8");

			const pushed = await pushTemplates(fakeApi, dir, { publish: true });
			expect(pushed.count).toBe(2);
			expect(patched).toHaveLength(1);
			expect(created).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}

		// Local dev email catcher handler test
		const { handle } = createDevHandler({ port: 4025 });
		const sendRes = handle("POST", "/api/emails", {
			from: "dev@example.com",
			to: ["user@example.com"],
			subject: "Local test email",
			html: "<p>Captured locally!</p>",
		});
		expect(sendRes.status).toBe(200);
		const { id } = JSON.parse(sendRes.body) as { id: string };
		expect(id).toMatch(/^dev_/);

		const listRes = handle("GET", "/api/emails");
		const listData = JSON.parse(listRes.body) as {
			data: { id: string; subject: string }[];
		};
		expect(listData.data[0]?.id).toBe(id);
		expect(listData.data[0]?.subject).toBe("Local test email");

		const oneRes = handle("GET", `/api/emails/${id}`);
		expect(oneRes.status).toBe(200);

		const uiRes = handle("GET", "/");
		expect(uiRes.status).toBe(200);
		expect(uiRes.body).toContain("Mailroom Dev");
	});
});
