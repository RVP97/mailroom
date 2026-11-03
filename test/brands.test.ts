import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { explainBounce } from "@/lib/bounces";
import { providerOf } from "@/lib/providers";
import { maskDigits } from "@/lib/roles";
import { listAccessLog } from "@/server/access-log";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { checkUnknownRecipients } from "@/server/auto-pause";
import { removeBrand, sendingStatus, viewScope } from "@/server/brands";
import { db, schema } from "@/server/db";
import {
	firewallBlocks,
	getFirewall,
	listEntry,
	refreshDisposableDomains,
	setFirewall,
} from "@/server/firewall";
import { lookupRecipient } from "@/server/lookup";
import { forgetOrg } from "@/server/org";
import { setDomainPaused } from "@/server/provision";
import { statsByProvider, suppressionsOf } from "@/server/queries";
import { createEmails, parseSend } from "@/server/send";
import { addSuppression } from "@/server/suppressions";
import { dayOf, iso } from "@/server/time";
import { createWebhook } from "@/server/webhook-admin";
import { DOWN_AFTER, deliverOne, emitEvent, replayFailed } from "@/server/webhooks";
import { fakeOutside, seedOrg, uid } from "./helpers";

// Request logs are written after the answer; the runner's own waitUntil can't hold this
// file's I/O.
vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const call = (
	key: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			method,
			headers: {
				authorization: `Bearer ${key}`,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);

/** An organization with an owner and a full key. */
async function organization() {
	const org = await seedOrg();
	const userId = `user_${uid()}`;
	await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@p.test` });
	await db.insert(schema.member).values({
		id: `mem_${uid()}`,
		organizationId: org.id,
		userId,
		role: "owner",
		createdAt: new Date(),
	});
	const { token } = await createKey({ organizationId: org.id, name: "app", permission: "full" });
	return { ...org, token, userId };
}

/** Another brand of the organization, ready to send from its own domain. */
async function brandOf(orgId: string, o: { marketing?: boolean } = {}) {
	const b = await seedOrg();
	await db.insert(schema.brands).values({
		id: b.id,
		parent_id: orgId,
		external_id: `ext_${uid()}`,
		created_at: iso(),
	});
	if (o.marketing)
		await db
			.update(schema.orgSending)
			.set({
				marketing_tenant_name: `mailroom-${b.slug}-mkt`,
				marketing_configuration_set: `mailroom-${b.slug}-mkt`,
			})
			.where(eq(schema.orgSending.organization_id, b.id));
	forgetOrg(b.id);
	forgetOrg(orgId);
	return b;
}

const send = (org: string, from: string, to: string | string[], extra: object = {}) =>
	createEmails(
		org,
		[parseSend({ from, to, subject: "Hola 123456", text: "Código 987654", ...extra })],
		{
			skipDns: true,
		},
	);

describe("brands", () => {
	it("creates one per external id through the API, and keeps /organizations working", async () => {
		// No AWS here: its SES setup fails and is left for later; the brand still exists.
		vi.spyOn(console, "error").mockImplementation(() => {});
		const p = await organization();
		const first = await call(p.token, "POST", "/brands", {
			name: "Harbor Inn",
			external_id: "harbor",
		});
		expect(first.status).toBe(201);
		const created = (await first.json()) as { id: string; slug: string; default: boolean };
		expect(created.slug).toMatch(new RegExp(`^${p.slug}-harbor-inn-`));
		expect(created.default).toBe(false);
		const again = await call(p.token, "POST", "/organizations", {
			name: "Harbor Inn",
			external_id: "harbor",
		});
		expect(((await again.json()) as { id: string }).id).toBe(created.id);

		const brands = (await (await call(p.token, "GET", "/brands")).json()) as {
			data: { id: string; default: boolean }[];
		};
		expect(brands.data.map((b) => [b.id, b.default])).toEqual([
			[p.id, true],
			[created.id, false],
		]);
		// The old list leaves the organization's own brand out, as it always did.
		const old = (await (await call(p.token, "GET", "/organizations")).json()) as {
			data: { id: string }[];
		};
		expect(old.data.map((b) => b.id)).toEqual([created.id]);
		// Brands have no people of their own.
		const members = await db
			.select()
			.from(schema.member)
			.where(eq(schema.member.organizationId, created.id));
		expect(members).toEqual([]);
	});

	it("acts on a brand by header or path, never on another organization's", async () => {
		fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id);
		for (const header of ["mailroom-brand", "mailroom-organization"]) {
			const res = await call(p.token, "GET", "/domains", undefined, { [header]: b.id });
			const list = (await res.json()) as { data: { brand_id: string }[] };
			expect(list.data.map((d) => d.brand_id)).toEqual([b.id]);
		}
		const byPath = (await (await call(p.token, "GET", `/brands/${b.id}/domains`)).json()) as {
			data: { name: string }[];
		};
		expect(byPath.data.map((d) => d.name)).toEqual([b.domain]);
		// Without a brand, reads cover all of them.
		const all = (await (await call(p.token, "GET", "/domains")).json()) as {
			data: { name: string }[];
		};
		expect(new Set(all.data.map((d) => d.name))).toEqual(new Set([p.domain, b.domain]));

		const other = await organization();
		expect(
			(await call(other.token, "GET", "/domains", undefined, { "mailroom-brand": b.id }))
				.status,
		).toBe(404);
		const sending = await createKey({ organizationId: p.id, name: "s", permission: "sending" });
		expect(
			(await call(sending.token, "GET", "/domains", undefined, { "mailroom-brand": b.id }))
				.status,
		).toBe(401);
	});

	it("opens a brand's suppression from the organization, never from another one", async () => {
		const p = await seedOrg();
		const b = await brandOf(p.id);
		const other = await seedOrg();
		await addSuppression(b.id, "Quien@Cliente.test");
		const mine = await viewScope(p.id);
		expect(
			(await suppressionsOf(mine.scope, "quien@cliente.test")).map((r) => r.organization_id),
		).toEqual([b.id]);
		expect(
			await suppressionsOf((await viewScope(other.id)).scope, "quien@cliente.test"),
		).toEqual([]);
		// Its own brand's scope only, when a brand is picked.
		expect(
			await suppressionsOf((await viewScope(p.id, p.id)).scope, "quien@cliente.test"),
		).toEqual([]);
	});

	it("sends as the brand whose domain is in From, and refuses a batch from two brands", async () => {
		const aws = fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id);
		const res = await call(p.token, "POST", "/emails", {
			from: `Hotel <reservas@${b.domain}>`,
			to: "ana@cliente.test",
			subject: "Reserva",
			text: "Hola",
		});
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };
		const row = await db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
		expect(row?.organization_id).toBe(b.id);
		expect(aws.sends[0]?.body.TenantName).toBe(`mailroom-${b.slug}`);

		const mixed = await call(p.token, "POST", "/emails/batch", [
			{ from: `a@${p.domain}`, to: "x@cliente.test", subject: "a", text: "a" },
			{ from: `a@${b.domain}`, to: "y@cliente.test", subject: "b", text: "b" },
		]);
		expect(mixed.status).toBe(422);
	});

	it("sends a marketing domain through the brand's second tenant, with the marketing group", async () => {
		const aws = fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id, { marketing: true });
		await db
			.update(schema.domains)
			.set({ purpose: "marketing" })
			.where(eq(schema.domains.organization_id, b.id));
		forgetOrg(b.id);
		const [r] = await send(b.id, `News <news@${b.domain}>`, "ana@cliente.test", {
			html: "<p>Ofertas</p>",
		});
		expect(r?.status).toBe("sent");
		expect(aws.sends[0]?.body.TenantName).toBe(`mailroom-${b.slug}-mkt`);
		expect(aws.sends[0]?.body.ConfigurationSetName).toBe(`mailroom-${b.slug}-mkt`);
		const row = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, r?.id as string))
			.get();
		expect(row?.unsubscribe_group).toBe("marketing");
	});

	it("refuses sends from a paused brand or domain, and lets them go once resumed", async () => {
		fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id);
		const paused = await call(p.token, "PATCH", `/brands/${b.id}`, { paused: true });
		expect(paused.status).toBe(200);
		const refused = await call(p.token, "POST", "/emails", {
			from: `a@${b.domain}`,
			to: "x@cliente.test",
			subject: "s",
			text: "t",
		});
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { name: string }).name).toBe("brand_paused");
		// Another brand keeps sending.
		expect((await send(p.id, `a@${p.domain}`, "x@cliente.test"))[0]?.status).toBe("sent");
		await call(p.token, "PATCH", `/brands/${b.id}`, { paused: false });

		await setDomainPaused(b.id, b.domainId, true);
		await expect(send(b.id, `a@${b.domain}`, "x@cliente.test")).rejects.toMatchObject({
			code: "domain_paused",
		});
		const status = await sendingStatus(p.id);
		expect(status.brands.find((x) => x.id === b.id)?.can_send).toBe(false);
		expect(status.can_send).toBe(true);
		await setDomainPaused(b.id, b.domainId, false);
		expect((await send(b.id, `a@${b.domain}`, "x@cliente.test"))[0]?.status).toBe("sent");
	});

	it("checks a sandbox send without recording or sending anything", async () => {
		const aws = fakeOutside();
		const p = await organization();
		await addSuppression(p.id, "gone@cliente.test");
		const before = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, p.id));
		const res = await call(p.token, "POST", "/emails", {
			from: `a@${p.domain}`,
			to: ["ok@cliente.test", "gone@cliente.test"],
			subject: "s",
			text: "t",
			sandbox: true,
		});
		const body = (await res.json()) as {
			object: string;
			would_send: boolean;
			recipients: { to: string[] };
			dropped_recipients: Record<string, string>;
		};
		expect(body.object).toBe("sandbox");
		expect(body.would_send).toBe(true);
		expect(body.recipients.to).toEqual(["ok@cliente.test"]);
		expect(body.dropped_recipients["gone@cliente.test"]).toMatch(/^suppressed/);
		expect(aws.sends).toHaveLength(0);
		const after = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, p.id));
		expect(after.length).toBe(before.length);
	});

	it("tells webhooks which brand an event is about", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
		const p = await organization();
		const b = await brandOf(p.id);
		const hook = await createWebhook(p.id, {
			url: "https://app.test/hook",
			events: ["email.delivered"],
		});
		await emitEvent(b.id, "email.delivered", `em_${uid()}`, {});
		const rows = await db
			.select()
			.from(schema.webhookDeliveries)
			.where(eq(schema.webhookDeliveries.webhook_id, hook.id));
		expect(rows).toHaveLength(1);
		const data = JSON.parse(rows[0]?.payload ?? "{}").data;
		expect(data.brand_id).toBe(b.id);
		expect(data.organization_id).toBe(b.id);
	});

	it("shows the dashboard every brand, or the one picked", async () => {
		fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id);
		const whole = await viewScope(p.id);
		expect(whole.scope).toEqual({ org: p.id });
		expect(whole.brands.map((x) => x.id)).toEqual([p.id, b.id]);
		expect((await viewScope(p.id, b.id)).scope).toBe(b.id);
		expect((await viewScope(p.id, "org_nope")).scope).toEqual({ org: p.id });
		const alone = await organization();
		expect(await viewScope(alone.id)).toEqual({ scope: alone.id, brands: [] });
	});

	it("removes a brand, moving its domains, suppressions and numbers to another", async () => {
		fakeOutside({
			extra: (url) =>
				url.host.startsWith("sts.")
					? new Response(
							"<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>",
						)
					: url.host.endsWith("amazonaws.com")
						? Response.json({})
						: undefined,
		});
		const p = await organization();
		const b = await brandOf(p.id);
		await addSuppression(b.id, "gone@cliente.test");
		await addSuppression(p.id, "gone@cliente.test");
		const day = dayOf(Date.now());
		await db.insert(schema.dailyStats).values([
			{ organization_id: p.id, day, sent: 10 },
			{ organization_id: b.id, day, sent: 5, bounced: 1 },
		]);
		const r = await removeBrand(p.id, b.id, p.id);
		expect(r).toMatchObject({ moved_to: p.id, domains: 1 });
		const domains = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.name, b.domain));
		expect(domains[0]?.organization_id).toBe(p.id);
		const stats = await db
			.select()
			.from(schema.dailyStats)
			.where(and(eq(schema.dailyStats.organization_id, p.id), eq(schema.dailyStats.day, day)))
			.get();
		expect(stats).toMatchObject({ sent: 15, bounced: 1 });
		const sup = await db
			.select()
			.from(schema.suppressions)
			.where(eq(schema.suppressions.address, "gone@cliente.test"));
		expect(sup.filter((s) => s.organization_id === p.id)).toHaveLength(1);
		await expect(removeBrand(p.id, p.id, b.id)).rejects.toMatchObject({
			code: "default_brand",
		});
	});

	it("lists 150 brands with their domains (past D1's 100 parameters)", async () => {
		fakeOutside();
		const p = await organization();
		const ids: string[] = [];
		for (let i = 0; i < 150; i++) ids.push((await brandOf(p.id)).id);
		const { brands } = await viewScope(p.id);
		expect(brands).toHaveLength(151);
		const status = await sendingStatus(p.id);
		expect(status.brands).toHaveLength(151);
		expect(status.brands.every((x) => x.domains.length === 1)).toBe(true);
	}, 120_000);
});

describe("email firewall", () => {
	it("is off until a check is turned on, and each check works on its own", async () => {
		const p = await organization();
		const list = [
			"a@mailinator.com",
			"ana+promo@cliente.test",
			"ana@gmail.com",
			"ok@cliente.test",
		];
		expect(await firewallBlocks(await getFirewall(p.id), list)).toEqual({});
		await setFirewall(p.id, { block_plus: true });
		expect(await firewallBlocks(await getFirewall(p.id), list)).toEqual({
			"ana+promo@cliente.test": "plus",
		});
		await setFirewall(p.id, { block_plus: false, block_free: true });
		expect(await firewallBlocks(await getFirewall(p.id), list)).toEqual({
			"ana@gmail.com": "free",
		});
		await setFirewall(p.id, { block_free: false, block_disposable: true });
		expect(await firewallBlocks(await getFirewall(p.id), list)).toEqual({
			"a@mailinator.com": "disposable",
		});
	});

	it("blocks «Never send to», lets «Always allow» win, and rejects what isn't a domain", async () => {
		const p = await organization();
		await setFirewall(p.id, {
			block_free: true,
			never: ["competitor.test", ".ru", "old@cliente.test"],
			always: ["boss@gmail.com", "news.competitor.test"],
		});
		const fw = await getFirewall(p.id);
		expect(
			await firewallBlocks(fw, [
				"x@competitor.test",
				"x@mail.competitor.test",
				"x@news.competitor.test",
				"x@yandex.ru",
				"old@cliente.test",
				"boss@gmail.com",
				"other@gmail.com",
			]),
		).toEqual({
			"x@competitor.test": "never",
			"x@mail.competitor.test": "never",
			"x@yandex.ru": "never",
			"old@cliente.test": "never",
			"other@gmail.com": "free",
		});
		expect(listEntry("*@Example.COM")).toBe("example.com");
		expect(listEntry("not a domain")).toBeNull();
		await expect(setFirewall(p.id, { never: ["not a domain"] })).rejects.toMatchObject({
			status: 422,
		});
	});

	it("is each brand's own, and drops blocked recipients like suppressed ones", async () => {
		fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id);
		await setFirewall(b.id, { block_plus: true });
		// The organization's own brand keeps its firewall off.
		const [free] = await send(p.id, `a@${p.domain}`, "z+3@cliente.test");
		expect(free?.status).toBe("sent");
		expect((await getFirewall(p.id)).block_plus).toBe(false);
		const r0 = await lookupRecipient(
			p.id,
			"z+3@cliente.test",
			{ channel: "api" },
			{ skipDns: true },
		);
		expect(r0.firewall).toEqual([
			{ brand_id: b.id, brand: expect.any(String), rule: "plus", reason: "plus address" },
		]);
		expect(r0.reasons[0]).toMatch(/'s firewall: plus address$/);
		const [r] = await send(b.id, `a@${b.domain}`, ["ok@cliente.test", "x+1@cliente.test"]);
		expect(r?.status).toBe("sent");
		const row = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, r?.id as string))
			.get();
		expect(row?.dropped).toEqual({ "x+1@cliente.test": "firewall: plus address" });
		const [only] = await send(b.id, `a@${b.domain}`, "y+2@cliente.test");
		expect(only?.status).toBe("suppressed");
	});

	it("checks 300 recipients in one batch with one disposable lookup per 90 domains", async () => {
		fakeOutside();
		const p = await organization();
		await setFirewall(p.id, { block_disposable: true });
		await db.insert(schema.disposableDomains).values({ domain: `trash${uid()}.test` });
		const [trash] = await db.select().from(schema.disposableDomains).limit(1);
		const list = Array.from({ length: 300 }, (_, i) =>
			i % 3 === 0 ? `u${i}@${trash?.domain}` : `u${i}@d${i}.cliente.test`,
		);
		const blocked = await firewallBlocks(await getFirewall(p.id), list);
		expect(Object.keys(blocked)).toHaveLength(100);
	});

	it("refreshes the disposable list, keeping the old one when the fetch looks wrong", async () => {
		const domains = Array.from({ length: 2500 }, (_, i) => `throwaway${i}.test`);
		const ok = (async () =>
			new Response(`# list\n${domains.join("\n")}\n`)) as unknown as typeof fetch;
		expect(await refreshDisposableDomains(ok)).toBe(2500);
		const short = (async () => new Response("a.test\nb.test")) as unknown as typeof fetch;
		await expect(refreshDisposableDomains(short)).rejects.toThrow(/only 2/);
		const rows = await db
			.select({ d: schema.disposableDomains.domain })
			.from(schema.disposableDomains);
		expect(rows).toHaveLength(2500);
	});
});

describe("recipients", () => {
	it("says why someone can't get email, across brands, and logs the lookup", async () => {
		fakeOutside();
		const p = await organization();
		const b = await brandOf(p.id);
		await addSuppression(b.id, "gone@cliente.test");
		await send(p.id, `a@${p.domain}`, "gone@cliente.test");
		const r = await lookupRecipient(
			p.id,
			"Gone@Cliente.test",
			{ channel: "api", actor: "API key «app»" },
			{ skipDns: true, maskDigits: true },
		);
		expect(r.can_receive).toBe(false);
		expect(r.reasons[0]).toMatch(/^Suppressed for Org/);
		expect(r.suppressions.map((s) => s.brand_id)).toEqual([b.id]);
		expect(r.emails).toHaveLength(1);
		expect(r.emails[0]?.subject).toBe("Hola ••••••");
		const log = await listAccessLog(p.id);
		expect(log[0]).toMatchObject({
			action: "recipient_lookup",
			subject: "gone@cliente.test",
			channel: "api",
			actor: "API key «app»",
		});
		const ok = await lookupRecipient(
			p.id,
			"new@cliente.test",
			{ channel: "dashboard" },
			{ skipDns: true },
		);
		expect(ok.can_receive).toBe(true);
	});

	it("explains bounces in plain words, naming the provider", () => {
		expect(
			explainBounce({
				type: "Permanent",
				subType: "General",
				message: "smtp; 550 5.1.1 The email account that you tried to reach does not exist",
				recipient: "Ana <ana@gmail.com>",
			}),
		).toMatchObject({ category: "unknown_recipient", retry: false });
		expect(
			explainBounce({
				type: "Permanent",
				message: "550 5.1.1 user unknown",
				recipient: "a@gmail.com",
			}).sentence,
		).toMatch(/^Gmail says/);
		expect(explainBounce({ type: "Transient", subType: "MailboxFull" }).category).toBe(
			"mailbox_full",
		);
		expect(explainBounce({ type: "Transient", subType: "General" }).category).toBe("temporary");
		expect(
			explainBounce({ type: "Permanent", message: "554 5.7.1 blocked by Spamhaus" }).category,
		).toBe("blocked");
		// iCloud's policy refusal comes as Transient/General: blocked, not "try later".
		expect(
			explainBounce({
				type: "Transient",
				subType: "General",
				message: "smtp; 554 5.7.1 Command rejected",
				recipient: "eva@icloud.com",
			}),
		).toMatchObject({ category: "blocked", title: "Blocked by iCloud", retry: true });
		expect(providerOf("x@hotmail.com")).toBe("outlook");
		expect(providerOf("x@empresa.mx")).toBe("other");
		expect(maskDigits("Su código es 482913, tel 55 1234")).toBe(
			"Su código es ••••••, tel 55 ••••",
		);
	});
});

describe("domain auto-pause", () => {
	async function bounced(brand: string, from: string, n: number, at: number, message: string) {
		const rows = Array.from({ length: n }, (_, i) => ({
			id: `em_${uid()}`,
			organization_id: brand,
			from,
			to: [`gone${i}@cliente.test`],
			subject: "s",
			status: "bounced" as const,
			bounce_type: "Permanent/General",
			error: message,
			bounced_at: iso(at),
			created_at: iso(at - 60_000),
		}));
		// D1 takes up to 100 parameters a statement.
		for (let i = 0; i < rows.length; i += 5)
			await db.insert(schema.emails).values(rows.slice(i, i + 5));
	}

	it("pauses a domain that keeps mailing addresses that don't exist, once, and emails the owners", async () => {
		const system: string[] = [];
		fakeOutside({
			extra: (url) => {
				system.push(url.toString());
				return Response.json({ MessageId: "x" });
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// 11:30 pm in Mexico on the 31st: already the 1st in UTC.
		const now = Date.parse("2026-10-31T23:30:00-06:00");
		const p = await organization();
		const b = await brandOf(p.id);
		await db.insert(schema.dailyStats).values({
			organization_id: b.id,
			day: dayOf(now),
			sent: 200,
			bounced: 40,
		});
		await bounced(b.id, `News <n@${b.domain}>`, 30, now - 3600_000, "550 5.1.1 user unknown");
		// Full mailboxes don't count.
		await bounced(b.id, `News <n@${b.domain}>`, 10, now - 3600_000, "552 5.2.2 mailbox full");
		const paused = await checkUnknownRecipients(now);
		expect(paused).toEqual([{ brand: b.id, domain: b.domain, count: 30 }]);
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, b.domainId))
			.get();
		expect(d?.paused_reason).toBe("unknown_recipients");
		// Resumed: the same bounces don't pause it again.
		await setDomainPaused(b.id, b.domainId, false, "you", now);
		expect(await checkUnknownRecipients(now + 60_000)).toEqual([]);
	});

	it("leaves a domain alone under the threshold", async () => {
		fakeOutside();
		const now = Date.now();
		const p = await organization();
		await db.insert(schema.dailyStats).values({
			organization_id: p.id,
			day: dayOf(now),
			sent: 5000,
			bounced: 30,
		});
		// 30 of 5,000 is under 5%.
		await bounced(p.id, `a@${p.domain}`, 30, now - 3600_000, "550 5.1.1 user unknown");
		expect(await checkUnknownRecipients(now)).toEqual([]);
	});
});

describe("webhook endpoints that are down", () => {
	it("goes Down after failures in a row, queues new events, recovers, and replays what failed", async () => {
		const p = await organization();
		const hook = await createWebhook(p.id, {
			url: "https://app.test/hook",
			events: ["email.delivered"],
		});
		const failing = (async () =>
			new Response("no", { status: 500 })) as unknown as typeof fetch;
		const now = Date.now();
		for (let i = 0; i < DOWN_AFTER; i++) {
			const id = `msg_${uid()}`;
			await db.insert(schema.webhookDeliveries).values({
				id,
				webhook_id: hook.id,
				organization_id: p.id,
				event_type: "email.delivered",
				payload: "{}",
				status: "pending",
				created_at: iso(now),
			});
			// The last try: given up at once.
			await deliverOne({ id, payload: "{}", attempts: 7 }, hook, failing, now);
		}
		const down = await db
			.select()
			.from(schema.webhooks)
			.where(eq(schema.webhooks.id, hook.id))
			.get();
		expect(down?.failures).toBe(DOWN_AFTER);
		expect(down?.down_since).not.toBeNull();

		// While Down, a new event isn't tried at once.
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockClear();
		await emitEvent(p.id, "email.delivered", `em_${uid()}`, {});
		expect(fetchSpy).not.toHaveBeenCalled();

		expect(await replayFailed(p.id, hook.id, { now })).toBe(DOWN_AFTER);
		const ok = (async () => new Response("ok")) as unknown as typeof fetch;
		await deliverOne({ id: `msg_${uid()}`, payload: "{}", attempts: 0 }, hook, ok, now);
		const back = await db
			.select()
			.from(schema.webhooks)
			.where(eq(schema.webhooks.id, hook.id))
			.get();
		expect(back).toMatchObject({ failures: 0, down_since: null });
	});
});

describe("stats by mailbox provider", () => {
	it("adds up per provider and day, the evening of the 31st on the 31st", async () => {
		const p = await organization();
		const day = dayOf(Date.parse("2026-10-31T23:30:00-06:00"));
		expect(day).toBe("2026-10-31");
		await db.insert(schema.providerStats).values([
			{
				organization_id: p.id,
				day: dayOf(Date.now()),
				provider: "gmail",
				sent: 100,
				delivered: 98,
				bounced: 2,
			},
			{
				organization_id: p.id,
				day: dayOf(Date.now()),
				provider: "outlook",
				sent: 50,
				delivered: 40,
				bounced: 10,
			},
		]);
		const rows = await statsByProvider({ org: p.id }, 7);
		expect(rows.map((r) => [r.provider, r.sent, r.bounce])).toEqual([
			["gmail", 100, "ok"],
			["outlook", 50, "danger"],
		]);
	});
});
