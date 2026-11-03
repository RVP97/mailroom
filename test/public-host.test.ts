import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createSegment } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { createNewsletter, handleNewsletterPage, hostHome } from "@/server/newsletters";
import { forgetOrg } from "@/server/org";
import {
	forgetHosts,
	inPublicScope,
	onOwnHost,
	publicUrl,
	scopeForHost,
} from "@/server/public-host";
import { createEmails, parseSend } from "@/server/send";
import { handleUnsubscribePage } from "@/server/unsubscribes";
import { fakeOutside, seedOrg, uid } from "./helpers";

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

const plain = (raw: string) =>
	raw
		.replace(
			/(Content-Transfer-Encoding: base64\r?\n\r?\n)([A-Za-z0-9+/=\r\n]+?)(?=\r?\n--)/g,
			(_m, head: string, b64: string) =>
				head +
				new TextDecoder().decode(
					Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
				),
		)
		.replace(/\r?\n[ \t]+/g, " ");

async function withHost(status = "active") {
	const org = await seedOrg();
	const host = `links.${org.domain}`;
	await db
		.update(schema.domains)
		.set({ tracking_host: host, tracking_status: status })
		.where(eq(schema.domains.id, org.domainId));
	forgetOrg(org.id);
	forgetHosts();
	return { ...org, host };
}

beforeEach(() => forgetHosts());

describe("a domain's own host for public pages", () => {
	it("moves links to Mailroom's public pages onto the host, and nothing else", () => {
		const out = onOwnHost(
			{
				html: '<a href="https://mailroom.test/unsubscribe?t=x">U</a><a href="https://mailroom.test/view/1">V</a><img src="https://mailroom.test/media/org/a.png"><a href="https://mailroom.test/emails">dash</a><a href="https://other.test/n/x">o</a>',
				text: "Read online: https://mailroom.test/n/news/hello",
				headers: { "List-Unsubscribe": "<https://mailroom.test/unsubscribe?t=x>" },
			},
			"https://links.acme.test",
		);
		expect(out.html).toContain('href="https://links.acme.test/unsubscribe?t=x"');
		expect(out.html).toContain('href="https://links.acme.test/view/1"');
		expect(out.html).toContain('src="https://links.acme.test/media/org/a.png"');
		expect(out.html).toContain('href="https://mailroom.test/emails"');
		expect(out.html).toContain('href="https://other.test/n/x"');
		expect(out.text).toBe("Read online: https://links.acme.test/n/news/hello");
		expect(out.headers?.["List-Unsubscribe"]).toBe("<https://links.acme.test/unsubscribe?t=x>");
		// No host: as it was.
		expect(onOwnHost({ html: "x" }, null)).toEqual({ html: "x" });
	});

	it("sends the unsubscribe link and header on the domain's live host, which then works", async () => {
		const aws = fakeOutside();
		const org = await withHost();
		const [r] = await createEmails(org.id, [
			parseSend({
				from: `hola@${org.domain}`,
				to: "ana@cliente.test",
				subject: "Novedades",
				html: "<p>Hola</p>",
				text: "Hola",
				unsubscribe_group: "news",
			}),
		]);
		expect(r).toBeTruthy();
		const raw = plain(rawOf(aws.sends[0] as never));
		const header = /List-Unsubscribe: <([^>]+)>/.exec(raw)?.[1] as string;
		expect(header.startsWith(`https://${org.host}/unsubscribe?t=`)).toBe(true);
		expect(raw).toContain(`href="https://${org.host}/unsubscribe?t=`);
		expect(raw).not.toContain("https://mailroom.test/unsubscribe");

		const own = await scopeForHost(org.host);
		expect(own).toEqual({
			base: `https://${org.host}`,
			organizationId: org.id,
			domain: org.domain,
		});
		const res = await inPublicScope(own as never, () =>
			handleUnsubscribePage(
				new Request(header, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "List-Unsubscribe=One-Click",
				}),
			),
		);
		expect(res.status).toBe(200);
	});

	it("keeps Mailroom's address while the host waits for its certificate", async () => {
		const aws = fakeOutside();
		const org = await withHost("pending");
		await createEmails(org.id, [
			parseSend({
				from: `hola@${org.domain}`,
				to: "ana@cliente.test",
				subject: "Novedades",
				html: "<p>Hola</p>",
				unsubscribe_group: "news",
			}),
		]);
		expect(plain(rawOf(aws.sends[0] as never))).toContain(
			"https://mailroom.test/unsubscribe?t=",
		);
		expect(await scopeForHost(org.host)).toBeNull();
	});

	it("serves the organization's newsletter there with its own links, and no one else's", async () => {
		const org = await withHost();
		const other = await seedOrg();
		const make = async (o: { id: string; domain: string }) =>
			createNewsletter(o.id, {
				name: `News ${uid()}`,
				segment_id: (await createSegment(o.id, { name: `All ${uid()}` })).id,
				from: `News <news@${o.domain}>`,
			});
		const mine = await make(org);
		const theirs = await make(other);
		const own = (await scopeForHost(org.host)) as NonNullable<
			Awaited<ReturnType<typeof scopeForHost>>
		>;

		const page = await inPublicScope(own, () =>
			handleNewsletterPage(new Request(`https://${org.host}/n/${mine.slug}`)),
		);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain(`https://${org.host}/n/${mine.slug}`);
		expect(html).not.toContain("https://mailroom.test/n/");

		const foreign = await inPublicScope(own, () =>
			handleNewsletterPage(new Request(`https://${org.host}/n/${theirs.slug}`)),
		);
		expect(foreign.status).toBe(404);

		// The host's root goes to its newsletter.
		const home = await inPublicScope(own, () => hostHome(own));
		expect(home.status).toBe(302);
		expect(home.headers.get("location")).toBe(`https://${org.host}/n/${mine.slug}`);

		// Outside the host, Mailroom's address as always.
		expect(publicUrl()).toBe("https://mailroom.test");
	});
});
