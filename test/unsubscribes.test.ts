import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { createEmails, parseSend } from "@/server/send";
import {
	handleUnsubscribePage,
	listUnsubscribes,
	readUnsubscribeToken,
	resubscribe,
	unsubscribe,
	unsubscribedAmong,
	unsubscribeToken,
} from "@/server/unsubscribes";
import { createWebhook } from "@/server/webhook-admin";
import { fakeOutside, seedOrg } from "./helpers";

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

/** The raw MIME with its base64 parts decoded, so links read in one piece. */
const plain = (raw: string) =>
	raw.replace(
		/(Content-Transfer-Encoding: base64\r?\n\r?\n)([A-Za-z0-9+/=\r\n]+?)(?=\r?\n--)/g,
		(_m, head: string, b64: string) =>
			head +
			new TextDecoder().decode(
				Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
			),
	);

const linkIn = (raw: string) => {
	const m = /List-Unsubscribe: <([^>]+)>/.exec(raw.replace(/\r?\n[ \t]+/g, " "));
	return m?.[1] as string;
};

const oneClick = (url: string) =>
	handleUnsubscribePage(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
		}),
	);

beforeEach(async () => {
	await db.delete(schema.unsubscribes);
	await db.delete(schema.emailBodies);
	await db.delete(schema.emails);
});

async function send(
	org: { id: string; domain: string },
	to: string | string[],
	o: { group?: string; html?: string; text?: string } = {},
) {
	const [r] = await createEmails(org.id, [
		parseSend({
			from: `"Acme Facturas" <hola@${org.domain}>`,
			to,
			subject: "Su factura",
			html: o.html ?? "<p>Hola</p>",
			text: o.text ?? "Hola",
			unsubscribe_group: o.group,
		}),
	]);
	return r as NonNullable<typeof r>;
}

describe("unsubscribe groups", () => {
	it("adds the one-click headers and a link, and leaves emails without a group alone", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		await send(org, "ana@cliente.test", { group: "customer_1" });
		await send(org, "ana@cliente.test");
		const [grouped, plainOne] = aws.sends.map((s) => plain(rawOf(s as never)));
		expect(grouped).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
		const url = linkIn(grouped as string);
		expect(url).toMatch(/\/unsubscribe\?t=[0-9a-f-]{36}\.[\w-]+\.[\w-]+$/);
		expect(grouped).toContain(`href="${url}"`);
		expect(grouped).toContain(`Unsubscribe: ${url}`);
		expect(plainOne).not.toContain("List-Unsubscribe");
	});

	it("puts the link where the placeholder is, in Spanish when the email is", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		await send(org, "ana@cliente.test", {
			group: "g",
			html: '<html lang="es"><body><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Baja</a></body></html>',
			text: "Baja: {{{MAILROOM_UNSUBSCRIBE_URL}}}",
		});
		const raw = plain(rawOf(aws.sends[0] as never));
		const url = linkIn(raw);
		expect(raw).not.toContain("UNSUBSCRIBE_URL}}}");
		expect(raw).toContain(`<a href="${url}">Baja</a>`);
		expect(raw).toContain(`Baja: ${url}`);
		expect(raw).not.toContain(">Unsubscribe</a>");
		await send(org, "luis@cliente.test", {
			group: "g",
			html: '<html lang="es"><body>Hola</body></html>',
		});
		expect(plain(rawOf(aws.sends[1] as never))).toContain(">Darse de baja</a>");
	});

	it("one-click leaves only that group: a webhook, an event, and later emails skip them", async () => {
		const posted: string[] = [];
		const aws = fakeOutside({
			extra: (url, init) => {
				if (url.host !== "hooks.acme.test") return undefined;
				posted.push(String(init?.body));
				return new Response("", { status: 200 });
			},
		});
		const org = await seedOrg();
		await createWebhook(org.id, {
			url: "https://hooks.acme.test/mail",
			events: ["email.unsubscribed"],
		});
		const first = await send(org, "Ana <Ana@Cliente.test>", { group: "customer_1" });
		const url = linkIn(plain(rawOf(aws.sends[0] as never)));

		// A scanner opening the link changes nothing.
		const get = await handleUnsubscribePage(new Request(url));
		expect(get.status).toBe(200);
		expect(await get.text()).toContain("Stop getting these emails from Acme Facturas?");
		expect(await unsubscribedAmong(org.id, "customer_1", ["ana@cliente.test"])).toEqual(
			new Set(),
		);

		const res = await oneClick(url);
		expect(res.status).toBe(200);
		expect(await unsubscribedAmong(org.id, "customer_1", ["ANA@cliente.test"])).toEqual(
			new Set(["ana@cliente.test"]),
		);
		const ev = await db
			.select()
			.from(schema.emailEvents)
			.where(eq(schema.emailEvents.email_id, first.id as string))
			.all();
		expect(ev.find((e) => e.type === "email.unsubscribed")?.recipient).toBe("ana@cliente.test");
		const deliveries = await db
			.select()
			.from(schema.webhookDeliveries)
			.where(
				and(
					eq(schema.webhookDeliveries.organization_id, org.id),
					eq(schema.webhookDeliveries.event_type, "email.unsubscribed"),
				),
			)
			.all();
		expect(deliveries).toHaveLength(1);
		expect(JSON.parse(deliveries[0]?.payload as string).data.unsubscribed).toEqual({
			email: "ana@cliente.test",
			group: "customer_1",
		});

		const again = await send(org, ["ana@cliente.test", "luis@cliente.test"], {
			group: "customer_1",
		});
		expect(again.status).toBe("sent");
		const row = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, again.id as string))
			.get();
		expect(row?.dropped).toEqual({ "ana@cliente.test": "unsubscribed (customer_1)" });

		const alone = await send(org, "ana@cliente.test", { group: "customer_1" });
		expect(alone.status).toBe("suppressed");

		// Another group and emails without one still reach her.
		expect((await send(org, "ana@cliente.test", { group: "customer_2" })).status).toBe("sent");
		expect((await send(org, "ana@cliente.test")).status).toBe("sent");
	});

	it("two one-clicks at once record one unsubscribe and one event", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		await send(org, "ana@cliente.test", { group: "g" });
		const url = linkIn(plain(rawOf(aws.sends[0] as never)));
		const all = await Promise.all([oneClick(url), oneClick(url), oneClick(url)]);
		expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
		expect((await listUnsubscribes(org.id)).data).toHaveLength(1);
		const ev = await db
			.select()
			.from(schema.emailEvents)
			.where(eq(schema.emailEvents.type, "email.unsubscribed"))
			.all();
		expect(ev.filter((e) => e.organization_id === org.id)).toHaveLength(1);
	});

	it("refuses a made-up or tampered link", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		const r = await send(org, "ana@cliente.test", { group: "g" });
		const url = linkIn(plain(rawOf(aws.sends[0] as never)));
		const t = new URL(url).searchParams.get("t") as string;
		const [id, , sig] = t.split(".");
		const other = `${id}.${btoa("luis@cliente.test").replace(/=+$/, "")}.${sig}`;
		expect(await readUnsubscribeToken(other)).toBeNull();
		expect((await oneClick(url.replace(t, other))).status).toBe(404);
		expect((await handleUnsubscribePage(new Request(`${url}x`))).status).toBe(404);
		// An email sent without a group has no link to make.
		const plainEmail = await send(org, "ana@cliente.test");
		expect(
			await readUnsubscribeToken(
				await unsubscribeToken(plainEmail.id as string, "ana@cliente.test"),
			),
		).toBeNull();
		expect(
			await readUnsubscribeToken(await unsubscribeToken(r.id as string, "ana@cliente.test")),
		).toMatchObject({
			organizationId: org.id,
			group: "g",
		});
		expect(await listUnsubscribes(org.id)).toEqual({ data: [], has_more: false });
	});

	it("the page unsubscribes and subscribes again, in Spanish when asked", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		await send(org, "ana@cliente.test", { group: "g" });
		const url = linkIn(plain(rawOf(aws.sends[0] as never)));
		const post = (body: string) =>
			handleUnsubscribePage(
				new Request(url, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						"accept-language": "es-MX,es;q=0.9",
					},
					body,
				}),
			);
		expect(await (await post("action=unsubscribe")).text()).toContain(
			"Listo: ya no recibirá estos correos de Acme Facturas.",
		);
		const shown = await handleUnsubscribePage(
			new Request(url, { headers: { "accept-language": "es" } }),
		);
		expect(await shown.text()).toContain("Volver a recibirlos");
		expect(await (await post("action=resubscribe")).text()).toContain("volverá a recibir");
		expect(await unsubscribedAmong(org.id, "g", ["ana@cliente.test"])).toEqual(new Set());
		expect((await send(org, "ana@cliente.test", { group: "g" })).status).toBe("sent");
	});

	it("checks a send to 150 people against the group in one go", async () => {
		fakeOutside();
		const org = await seedOrg();
		const people = Array.from({ length: 150 }, (_, i) => `p${i}@cliente.test`);
		const r = await send(org, people[0] as string, { group: "big" });
		for (const a of people.filter((_, i) => i % 3 === 0))
			await unsubscribe({
				organizationId: org.id,
				group: "big",
				address: a,
				emailId: r.id as string,
			});
		const out = await unsubscribedAmong(org.id, "big", people);
		expect(out.size).toBe(50);
		const results = await createEmails(
			org.id,
			[0, 50, 100].map((i) =>
				parseSend({
					from: `hola@${org.domain}`,
					to: people.slice(i, i + 25),
					bcc: people.slice(i + 25, i + 50),
					subject: "Aviso",
					text: "t",
					unsubscribe_group: "big",
				}),
			),
		);
		let dropped = 0;
		for (const r2 of results) {
			const row = await db
				.select()
				.from(schema.emails)
				.where(eq(schema.emails.id, r2.id as string))
				.get();
			dropped += Object.keys(row?.dropped ?? {}).length;
		}
		expect(dropped).toBe(50);
		const page1 = await listUnsubscribes(org.id, { group: "big", limit: 40 });
		expect(page1.data).toHaveLength(40);
		expect(page1.has_more).toBe(true);
		expect(await resubscribe(org.id, "big", "P0@cliente.test")).toBe(true);
		expect((await unsubscribedAmong(org.id, "big", people)).size).toBe(49);
	});

	it("refuses a group that isn't an id", () => {
		expect(() =>
			parseSend({
				from: "a@b.test",
				to: "c@d.test",
				subject: "s",
				text: "t",
				unsubscribe_group: "a b",
			}),
		).toThrow();
	});
});
