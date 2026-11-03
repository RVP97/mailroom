import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dnsHostFromNameservers, recordNameForHost } from "@/lib/dns-hosts";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { db, schema } from "@/server/db";
import { applyUrl, connectRecords, dnsHelp, forgetDnsHosts } from "@/server/domain-connect";
import { forgetOrg } from "@/server/org";
import { dnsRecords, syncEventDestinations } from "@/server/provision";
import { createEmails, parseSend } from "@/server/send";
import { clearSettingsCache, getSetting, setSetting } from "@/server/settings";
import {
	addTrackingHost,
	clickUrl,
	handleTracking,
	openUrl,
	removeTrackingHost,
	trackHtml,
} from "@/server/tracking";
import { fakeOutside, seedOrg } from "./helpers";

const vars = env as unknown as {
	TRACKING_ZONE_ID?: string;
	TRACKING_CNAME_TARGET?: string;
	CLOUDFLARE_API_TOKEN?: string;
	DOMAIN_CONNECT_PRIVATE_KEY?: string;
};

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

/** The raw MIME with its base64 parts decoded. */
const plain = (raw: string) =>
	raw.replace(
		/(Content-Transfer-Encoding: base64\r?\n\r?\n)([A-Za-z0-9+/=\r\n]+?)(?=\r?\n--)/g,
		(_m, head: string, b64: string) =>
			head +
			new TextDecoder().decode(
				Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
			),
	);

const emailRow = (id: string) =>
	db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();

beforeEach(() => {
	clearSettingsCache();
	forgetDnsHosts();
});

afterEach(() => {
	vars.TRACKING_ZONE_ID = undefined;
	vars.TRACKING_CNAME_TARGET = undefined;
	vars.CLOUDFLARE_API_TOKEN = undefined;
	vars.DOMAIN_CONNECT_PRIVATE_KEY = undefined;
});

const ID = "0b9d1f3e-4c2a-4f8e-9a77-2d5c1e6f8a90";
const T = { open: true, click: true, base: "https://links.acme.test" };

describe("tracking HTML", () => {
	it("sends web links through the tracking host and adds the open image before </body>", async () => {
		const html = `<html><body><a href="https://acme.test/factura?id=1&amp;x=2">Ver</a> <a class="b" href='http://acme.test/b'>B</a></body></html>`;
		const out = await trackHtml(html, ID, T);
		const links = [...out.matchAll(/href="([^"]+)"/g)].map((m) => m[1]?.replace(/&amp;/g, "&"));
		expect(links).toEqual([
			await clickUrl(T.base, ID, "https://acme.test/factura?id=1&x=2"),
			await clickUrl(T.base, ID, "http://acme.test/b"),
		]);
		expect(out).toContain('class="b"');
		expect(out).toMatch(
			new RegExp(`<img src="${await openUrl(T.base, ID)}"[^>]*/></body></html>$`),
		);
	});

	it("leaves mailto, anchors, placeholders, the unsubscribe link and opted-out links alone", async () => {
		const html = [
			'<a href="mailto:ana@acme.test">m</a>',
			'<a href="#top">t</a>',
			'<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">u</a>',
			'<a href="https://mailroom.test/unsubscribe?t=abc">u2</a>',
			'<a data-mailroom-track="false" href="https://acme.test/login?token=1">l</a>',
			"<a name=x>no href</a>",
		].join("");
		expect(await trackHtml(html, ID, { ...T, open: false })).toBe(html);
	});

	it("only adds the image with click tracking off, and only links with open tracking off", async () => {
		const html = '<p><a href="https://acme.test">a</a></p>';
		const opens = await trackHtml(html, ID, { ...T, click: false });
		expect(opens).toContain('href="https://acme.test"');
		expect(opens).toContain("/o/");
		const clicks = await trackHtml(html, ID, { ...T, open: false });
		expect(clicks).not.toContain("<img");
		expect(clicks).toContain("/c/");
	});
});

describe("tracking requests", () => {
	it("a click is recorded once per request and redirects; a forged one is refused", async () => {
		fakeOutside();
		const org = await seedOrg();
		const [r] = await createEmails(org.id, [
			parseSend({
				from: `hola@${org.domain}`,
				to: "ana@cliente.test",
				subject: "s",
				text: "t",
			}),
		]);
		const id = r?.id as string;
		const url = await clickUrl("https://links.x.test", id, "https://acme.test/pago");
		const res = await handleTracking(new Request(url));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("https://acme.test/pago");
		await handleTracking(new Request(url));
		const head = await handleTracking(new Request(url, { method: "HEAD" }));
		expect(head.status).toBe(302);
		const row = await emailRow(id);
		expect(row?.click_count).toBe(2);
		expect(row?.clicked_at).toBeTruthy();
		const events = await db
			.select()
			.from(schema.emailEvents)
			.where(eq(schema.emailEvents.email_id, id));
		const clicks = events.filter((e) => e.type === "email.clicked");
		expect(clicks).toHaveLength(2);
		expect((clicks[0]?.data as { click: { link: string } }).click.link).toBe(
			"https://acme.test/pago",
		);

		const forged = url.replace(/\/[^/]+\/[^/]+$/, (m) =>
			m.replace(/[^/]+$/, "AAAAAAAAAAAAAAAA"),
		);
		expect((await handleTracking(new Request(forged))).status).toBe(404);
		const elsewhere = url.replace(
			/\/c\/([^/]+)\/[^/]+\//,
			`/c/$1/${btoa("https://evil.test").replace(/=+$/, "")}/`,
		);
		expect((await handleTracking(new Request(elsewhere))).status).toBe(404);
	});

	it("an open returns the image and is recorded", async () => {
		fakeOutside();
		const org = await seedOrg();
		const [r] = await createEmails(org.id, [
			parseSend({
				from: `hola@${org.domain}`,
				to: "ana@cliente.test",
				subject: "s",
				text: "t",
			}),
		]);
		const id = r?.id as string;
		const res = await handleTracking(new Request(await openUrl("https://mailroom.test", id)));
		expect(res.headers.get("content-type")).toBe("image/gif");
		expect((await emailRow(id))?.open_count).toBe(1);
		const bad = await handleTracking(new Request(`https://mailroom.test/o/${id}/nope`));
		expect(bad.headers.get("content-type")).toBe("image/gif");
		expect((await emailRow(id))?.open_count).toBe(1);
	});
});

describe("sending with tracking", () => {
	it("SES tracks until the configuration sets are moved; then Mailroom rewrites the HTML", async () => {
		const puts: string[] = [];
		const aws = fakeOutside({
			extra: (url, init) => {
				if (url.host === "email.us-east-1.amazonaws.com" && init?.method === "PUT") {
					puts.push(url.pathname);
					const body = JSON.parse(String(init.body));
					expect(body.EventDestination.MatchingEventTypes).not.toContain("OPEN");
					expect(body.EventDestination.MatchingEventTypes).toContain("DELIVERY");
					return Response.json({});
				}
				return undefined;
			},
		});
		await setSetting("sns_topic_arn", "arn:aws:sns:us-east-1:123456789012:mailroom-ses-events");
		const org = await seedOrg();
		const send = () =>
			createEmails(org.id, [
				parseSend({
					from: `hola@${org.domain}`,
					to: "ana@cliente.test",
					subject: "Su factura",
					html: '<p><a href="https://acme.test/f/1">Ver factura</a></p>',
					text: "Ver factura: https://acme.test/f/1",
				}),
			]);
		await send();
		expect(plain(rawOf(aws.sends[0] as never))).toContain('href="https://acme.test/f/1"');

		await db.delete(schema.appSettings).where(eq(schema.appSettings.key, "own_tracking_at"));
		clearSettingsCache();
		expect(await syncEventDestinations()).toBe("done");
		expect(puts).toContain(
			`/v2/email/configuration-sets/${org.configurationSet}/event-destinations/mailroom`,
		);
		expect(await getSetting("own_tracking_at")).toBeTruthy();

		await send();
		const html = plain(rawOf(aws.sends[1] as never));
		expect(html).toMatch(/href="https:\/\/mailroom\.test\/c\/[0-9a-f-]{36}\/[\w-]+\/[\w-]+"/);
		expect(html).toMatch(/<img src="https:\/\/mailroom\.test\/o\//);

		// Off for the domain: the HTML goes as written.
		await db
			.update(schema.domains)
			.set({ open_tracking: false, click_tracking: false })
			.where(eq(schema.domains.id, org.domainId));
		forgetOrg(org.id);
		await send();
		expect(plain(rawOf(aws.sends[2] as never))).toContain('href="https://acme.test/f/1"');

		// An active links.<domain>: links use it.
		await db
			.update(schema.domains)
			.set({
				click_tracking: true,
				tracking_host: `links.${org.domain}`,
				tracking_status: "active",
			})
			.where(eq(schema.domains.id, org.domainId));
		forgetOrg(org.id);
		await send();
		expect(plain(rawOf(aws.sends[3] as never))).toContain(
			`href="https://links.${org.domain}/c/`,
		);
		await db.delete(schema.appSettings).where(eq(schema.appSettings.key, "own_tracking_at"));
		clearSettingsCache();
	});
});

describe("tracking host (Cloudflare for SaaS)", () => {
	it("adds a custom hostname and a Worker route, shows its CNAME, and removes both", async () => {
		vars.TRACKING_ZONE_ID = "zone1";
		vars.TRACKING_CNAME_TARGET = "track.mailroom.test";
		vars.CLOUDFLARE_API_TOKEN = "token";
		const cf: string[] = [];
		fakeOutside({
			extra: async (url, init) => {
				if (url.host !== "api.cloudflare.com") return undefined;
				const method = init?.method ?? "GET";
				cf.push(`${method} ${url.pathname}`);
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				if (method === "POST" && url.pathname.endsWith("/custom_hostnames"))
					return Response.json({
						success: true,
						result: { id: "ch1", hostname: body.hostname, status: "pending" },
					});
				if (method === "POST" && url.pathname.endsWith("/workers/routes")) {
					expect(body).toEqual({ pattern: body.pattern, script: "mailroom" });
					return Response.json({ success: true, result: { id: "r1" } });
				}
				if (method === "GET" && url.pathname.endsWith("/custom_hostnames/ch1"))
					return Response.json({
						success: true,
						result: {
							id: "ch1",
							status: "pending",
							ssl: { status: "pending_validation" },
						},
					});
				return Response.json({ success: true, result: {} });
			},
		});
		const org = await seedOrg();
		const d = await addTrackingHost(org.id, org.domainId);
		expect(d.tracking_host).toBe(`links.${org.domain}`);
		expect(d.tracking_status).toBe("pending");
		expect(cf).toContain("POST /client/v4/zones/zone1/workers/routes");
		const row = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		const record = dnsRecords(row as NonNullable<typeof row>).find(
			(r) => r.record === "Tracking",
		);
		expect(record).toMatchObject({
			type: "CNAME",
			name: `links.${org.domain}`,
			value: "track.mailroom.test",
			status: "PENDING",
		});

		await removeTrackingHost(org.id, org.domainId);
		expect(cf).toContain("DELETE /client/v4/zones/zone1/workers/routes/r1");
		expect(cf).toContain("DELETE /client/v4/zones/zone1/custom_hostnames/ch1");

		// links. taken by another service (Resend's tracking, say): another name.
		await expect(addTrackingHost(org.id, org.domainId, "no.dots")).rejects.toThrow();
		const t = await addTrackingHost(org.id, org.domainId, "track");
		expect(t.tracking_host).toBe(`track.${org.domain}`);
	});

	it("turns the tracking host on and off through PATCH /api/domains/:id", async () => {
		vars.TRACKING_ZONE_ID = "zone1";
		vars.TRACKING_CNAME_TARGET = "track.mailroom.test";
		vars.CLOUDFLARE_API_TOKEN = "token";
		fakeOutside({
			extra: async (url, init) => {
				if (url.host !== "api.cloudflare.com") return undefined;
				const method = init?.method ?? "GET";
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				if (method === "POST" && url.pathname.endsWith("/custom_hostnames"))
					return Response.json({
						success: true,
						result: { id: "ch2", hostname: body.hostname },
					});
				if (method === "POST" && url.pathname.endsWith("/workers/routes"))
					return Response.json({ success: true, result: { id: "r2" } });
				if (method === "GET" && url.pathname.endsWith("/custom_hostnames/ch2"))
					return Response.json({
						success: true,
						result: {
							id: "ch2",
							status: "pending",
							ssl: { status: "pending_validation" },
						},
					});
				return Response.json({ success: true, result: {} });
			},
		});
		const org = await seedOrg();
		const { token } = await createKey({
			organizationId: org.id,
			name: "test",
			permission: "full",
		});
		const patch = (body: unknown) =>
			handleApi(
				new Request(`https://mailroom.test/api/domains/${org.domainId}`, {
					method: "PATCH",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			);
		const on = await patch({ tracking_subdomain: "links" });
		expect(on.status).toBe(200);
		const view = (await on.json()) as {
			tracking_domain: { name: string; status: string } | null;
			records: { record: string; name: string }[];
		};
		expect(view.tracking_domain).toEqual({ name: `links.${org.domain}`, status: "pending" });
		expect(view.records.find((r) => r.record === "Tracking")?.name).toBe(`links.${org.domain}`);
		expect((await patch({ tracking_subdomain: "no.dots" })).status).toBe(422);
		const off = (await (await patch({ tracking_subdomain: null })).json()) as {
			tracking_domain: unknown;
		};
		expect(off.tracking_domain).toBeNull();
	});
});

describe("DNS host and one-click setup", () => {
	it("tells DNS hosts apart by nameserver and writes names the way each wants", () => {
		const cf = dnsHostFromNameservers(["ada.ns.cloudflare.com."], "acme.com.mx");
		expect(cf?.name).toBe("Cloudflare");
		expect(cf?.dnsUrl).toContain("acme.com.mx/dns/records");
		expect(recordNameForHost("bounce.mail.acme.com.mx", "acme.com.mx", cf)).toBe("bounce.mail");
		const r53 = dnsHostFromNameservers(["ns-1.awsdns-01.org"], "acme.com");
		expect(recordNameForHost("bounce.acme.com", "acme.com", r53)).toBe("bounce.acme.com");
		expect(dnsHostFromNameservers(["ns1.example.net"], "acme.com")).toBeNull();
	});

	const domain = {
		name: "mail.acme.com",
		region: "us-east-2",
		dkim_tokens: [
			"abcdefghijklmnopqrstuvwxyz012345",
			"bbcdefghijklmnopqrstuvwxyz012345",
			"cbcdefghijklmnopqrstuvwxyz012345",
		],
		dkim_status: "PENDING",
		mail_from: "bounce.mail.acme.com",
		mail_from_status: "PENDING",
		status: "pending",
		tracking_host: null,
		tracking_status: null,
	};

	it("asks only for what's missing, and nothing it can't write whole", () => {
		expect(connectRecords(domain, { dmarc: false, bimi: true })).toEqual({
			variables: {
				dkim1: domain.dkim_tokens[0],
				dkim2: domain.dkim_tokens[1],
				dkim3: domain.dkim_tokens[2],
				region: "us-east-2",
			},
			groups: ["dkim", "mailfrom", "dmarc"],
		});
		expect(
			connectRecords(
				{ ...domain, dkim_status: "SUCCESS", mail_from_status: "SUCCESS", has_logo: true },
				{ dmarc: true, bimi: false },
			),
		).toEqual({ variables: {}, groups: ["bimi"] });
		expect(
			connectRecords(
				{ ...domain, dkim_status: "SUCCESS", mail_from_status: "SUCCESS" },
				{ dmarc: true, bimi: true },
			),
		).toBeNull();
		// Another app's MAIL FROM: set up by hand.
		expect(
			connectRecords(
				{ ...domain, mail_from: "mail.mail.acme.com" },
				{ dmarc: true, bimi: true },
			),
		).toBeNull();
	});

	it("signs the apply link so the host can check it with the published key", async () => {
		const keys = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const pkcs8 = new Uint8Array(
			(await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer,
		);
		const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
		const url = await applyUrl({
			urlSyncUX: "https://dash.cloudflare.com/domainconnect/",
			domain: "mail.acme.com",
			variables: { dkim1: "a1" },
			groups: ["dkim", "dmarc"],
			redirectUri: "https://mailroom.test/domains/d1?connected=1",
			privateKeyPem: pem,
		});
		expect(url).toMatch(
			/^https:\/\/dash\.cloudflare\.com\/domainconnect\/v2\/domainTemplates\/providers\/mailroom\.test\/services\/sending-domain\/apply\?domain=acme\.com&host=mail&groupId=dkim%2Cdmarc&dkim1=a1&redirect_uri=/,
		);
		const [query, rest] = (url.split("?")[1] as string).split("&key=") as [string, string];
		expect(rest.startsWith("_dck1&sig=")).toBe(true);
		const sig = Uint8Array.from(atob(decodeURIComponent(rest.slice(10))), (c) =>
			c.charCodeAt(0),
		);
		expect(
			await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				keys.publicKey,
				sig,
				new TextEncoder().encode(query),
			),
		).toBe(true);
		vars.DOMAIN_CONNECT_PRIVATE_KEY = pem;

		// The host, found by its nameservers; the button only once it has the template.
		let template = 404;
		fakeOutside({
			extra: (u) => {
				if (u.host === "api.cloudflare.com" && u.pathname.endsWith("/v2/acme.com/settings"))
					return Response.json({
						providerName: "cloudflare",
						providerDisplayName: "Cloudflare",
						urlSyncUX: "https://dash.cloudflare.com/domainconnect",
						urlAPI: "https://api.cloudflare.com/client/v4/dns/domainconnect",
					});
				if (u.pathname.endsWith("/services/sending-domain"))
					return new Response("{}", { status: template });
				return undefined;
			},
		});
		const dns = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const u = new URL(String(input instanceof Request ? input.url : input));
			if (u.host === "cloudflare-dns.com") {
				const name = u.searchParams.get("name");
				const type = u.searchParams.get("type");
				if (name === "acme.com" && type === "NS")
					return Response.json({ Answer: [{ type: 2, data: "ada.ns.cloudflare.com." }] });
				if (name === "_domainconnect.acme.com")
					return Response.json({
						Answer: [
							{ type: 16, data: '"api.cloudflare.com/client/v4/dns/domainconnect"' },
						],
					});
				return Response.json({});
			}
			return dns(input, init);
		}) as typeof fetch;
		try {
			const before = await dnsHelp(domain, { dmarc: true, bimi: true }, "https://m.test/r");
			expect(before.host?.name).toBe("Cloudflare");
			expect(before.root).toBe("acme.com");
			expect(before.connect).toBeNull();
			forgetDnsHosts();
			template = 200;
			const after = await dnsHelp(domain, { dmarc: true, bimi: true }, "https://m.test/r");
			expect(after.connect?.providerName).toBe("Cloudflare");
			expect(after.connect?.url).toContain("groupId=dkim%2Cmailfrom&");
		} finally {
			globalThis.fetch = dns;
		}
	});
});
