import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { createSegment } from "@/server/contacts";
import { db, schema } from "@/server/db";
import {
	confirmToken,
	createForm,
	formEmbed,
	handleSubscribe,
	updateForm,
} from "@/server/signup-forms";
import { fakeOutside, seedOrg, uid } from "./helpers";

const vars = env as unknown as { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string };
afterEach(() => {
	vars.CLOUDFLARE_ACCOUNT_ID = undefined;
	vars.CLOUDFLARE_API_TOKEN = undefined;
});

const post = (id: string, fields: Record<string, string>, json = false) =>
	handleSubscribe(
		new Request(`https://mailroom.test/subscribe/${id}`, {
			method: "POST",
			headers: json
				? { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }
				: { "content-type": "application/x-www-form-urlencoded" },
			body: json ? JSON.stringify(fields) : new URLSearchParams(fields),
		}),
	);

const confirmationsTo = (brand: string, to: string) =>
	db
		.select({ id: schema.emails.id, to: schema.emails.to, subject: schema.emails.subject })
		.from(schema.emails)
		.where(eq(schema.emails.organization_id, brand))
		.then((rows) => rows.filter((r) => r.to.includes(to)));

async function setUp() {
	fakeOutside();
	const org = await seedOrg();
	const segment = await createSegment(org.id, { name: "Newsletter" });
	const form = await createForm(org.id, {
		name: "Footer",
		title: "The Harbor newsletter",
		from: `hola@${org.domain}`,
		segment_id: segment.id,
	});
	return { org, segment, form };
}

describe("sign-up forms", () => {
	it("emails a confirmation, and only the click adds the contact to the segment", async () => {
		const { org, segment, form } = await setUp();
		const email = `ana-${uid()}@cliente.test`;

		const res = await post(form.id, { email, first_name: "Ana" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(
			`https://mailroom.test/subscribe/${form.id}?sent=1`,
		);
		expect(await confirmationsTo(org.id, email)).toEqual([
			expect.objectContaining({
				subject: "Confirm your subscription to The Harbor newsletter",
			}),
		]);
		// Not a contact until they confirm.
		const before = await db
			.select()
			.from(schema.contacts)
			.where(
				and(eq(schema.contacts.organization_id, org.id), eq(schema.contacts.email, email)),
			)
			.get();
		expect(before).toBeUndefined();

		const token = await confirmToken({ f: form.id, e: email, n: "Ana" });
		const ok = await handleSubscribe(
			new Request(`https://mailroom.test/subscribe/confirm?t=${token}`),
		);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain("You're subscribed");
		const c = await db
			.select()
			.from(schema.contacts)
			.where(
				and(eq(schema.contacts.organization_id, org.id), eq(schema.contacts.email, email)),
			)
			.get();
		expect(c).toMatchObject({ first_name: "Ana", unsubscribed: false });
		const inSegment = await db
			.select()
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.contact_id, c?.id as string))
			.get();
		expect(inSegment?.segment_id).toBe(segment.id);
		const counts = await db
			.select({
				signups: schema.signupForms.signups,
				confirmed: schema.signupForms.confirmed,
			})
			.from(schema.signupForms)
			.where(eq(schema.signupForms.id, form.id))
			.get();
		expect(counts).toEqual({ signups: 1, confirmed: 1 });

		// Signing up again once subscribed sends nothing, and says the same.
		const again = await post(form.id, { email }, true);
		expect(await again.json()).toEqual({ ok: true, message: "Check your inbox to confirm." });
		expect(again.headers.get("access-control-allow-origin")).toBe("*");
		expect(await confirmationsTo(org.id, email)).toHaveLength(1);
	});

	it("ignores bots, bad addresses and forged links", async () => {
		const { org, form } = await setUp();
		const bot = `bot-${uid()}@cliente.test`;
		expect((await post(form.id, { email: bot, website: "http://spam.test" })).status).toBe(303);
		expect(await confirmationsTo(org.id, bot)).toEqual([]);
		expect((await post(form.id, { email: "not an email" }, true)).status).toBe(400);

		const token = await confirmToken({ f: form.id, e: "eve@cliente.test" });
		const forged = `${token.split(".")[0]}x.${token.split(".")[1]}`;
		const res = await handleSubscribe(
			new Request(`https://mailroom.test/subscribe/confirm?t=${forged}`),
		);
		expect(res.status).toBe(400);
		const expired = await handleSubscribe(
			new Request(`https://mailroom.test/subscribe/confirm?t=${token}`),
			Date.now() + 8 * 86_400_000,
		);
		expect(expired.status).toBe(400);
		expect(
			(await handleSubscribe(new Request("https://mailroom.test/subscribe/frm_nope"))).status,
		).toBe(404);
	});

	it("only sends from the brand's verified domains", async () => {
		const { org } = await setUp();
		await expect(
			createForm(org.id, { name: "x", from: "hola@someone-else.test" }),
		).rejects.toThrow(/verified domains/);
	});

	it("makes the brand's Turnstile widget for its forms' websites, and checks it", async () => {
		const calls: { method: string; url: string; body: unknown }[] = [];
		let verified = true;
		fakeOutside({
			extra: async (url, init) => {
				if (url.host === "api.cloudflare.com") {
					const body = init?.body ? JSON.parse(String(init.body)) : null;
					calls.push({ method: init?.method ?? "GET", url: url.pathname, body });
					return Response.json({
						success: true,
						result: { sitekey: "0x4AAA-site", secret: "0x4AAA-secret", ...body },
					});
				}
				if (url.host === "challenges.cloudflare.com")
					return Response.json({ success: verified, hostname: "hotel.test" });
				return undefined;
			},
		});
		vars.CLOUDFLARE_ACCOUNT_ID = "acct1";
		vars.CLOUDFLARE_API_TOKEN = "token";
		const org = await seedOrg();
		const form = await createForm(org.id, {
			name: "Footer",
			from: `hola@${org.domain}`,
			website: "https://hotel.test/blog",
		});
		expect(calls).toEqual([
			{
				method: "POST",
				url: "/client/v4/accounts/acct1/challenges/widgets",
				body: {
					name: `Mailroom · Org ${org.id}`,
					domains: ["mailroom.test", "hotel.test"],
					mode: "managed",
				},
			},
		]);
		// The snippet carries the widget; a sign-up without its token is refused.
		const { token } = await createKey({
			organizationId: org.id,
			name: "t",
			permission: "full",
		});
		const view = (await (
			await handleApi(
				new Request(`https://mailroom.test/api/signup-forms/${form.id}`, {
					headers: { authorization: `Bearer ${token}` },
				}),
			)
		).json()) as { html: string; turnstile: boolean };
		expect(view.turnstile).toBe(true);
		expect(view.html).toContain('data-sitekey="0x4AAA-site"');
		expect((await post(form.id, { email: `x-${uid()}@cliente.test` }, true)).status).toBe(403);
		expect(
			(
				await post(
					form.id,
					{ email: `y-${uid()}@cliente.test`, "cf-turnstile-response": "tok" },
					true,
				)
			).status,
		).toBe(200);
		verified = false;
		expect(
			(
				await post(
					form.id,
					{ email: `z-${uid()}@cliente.test`, "cf-turnstile-response": "tok" },
					true,
				)
			).status,
		).toBe(403);
	});
});

describe("sign-up form design", () => {
	it("keeps its look, merges changes, and the code and page carry it", async () => {
		fakeOutside();
		const org = await seedOrg();
		const form = await createForm(org.id, {
			name: "Footer",
			title: "Noticias",
			from: `hola@${org.domain}`,
			design: {
				button: "Suscríbete",
				accent: "#2563EB",
				template: "banner",
				display: "popup",
				radius: "bogus",
			},
		});
		expect(form.design).toMatchObject({
			button: "Suscríbete",
			accent: "#2563eb",
			template: "banner",
			display: "popup",
			radius: "medium",
		});
		const updated = await updateForm(org.id, form.id, { design: { success: "¡Gracias!" } });
		expect(updated.design).toMatchObject({ button: "Suscríbete", success: "¡Gracias!" });

		const { html, script } = await formEmbed(updated);
		expect(html).toContain("<span>Suscríbete</span></button>");
		expect(html).toContain(`id="mr-${form.id}"`);
		expect(html).toContain("background:#2563eb");
		expect(html).toContain("¡Gracias!");
		expect(html).toContain('class="mr-layer"');
		expect(script).toBe(
			`<script src="https://mailroom.test/subscribe/${form.id}.js" async></script>`,
		);
		// The hosted page shows it in the page, not as a popup.
		const page = await (
			await handleSubscribe(new Request(`https://mailroom.test/subscribe/${form.id}`))
		).text();
		expect(page).toContain("<span>Suscríbete</span></button>");
		expect(page).not.toContain('class="mr-layer"');
		// The script embed carries the current design.
		const js = await handleSubscribe(
			new Request(`https://mailroom.test/subscribe/${form.id}.js`),
		);
		expect(js.headers.get("content-type")).toContain("javascript");
		expect(await js.text()).toContain("¡Gracias!");
	});

	it("takes the finer options: logo, border, button, overlay and the bar's look", async () => {
		fakeOutside();
		const org = await seedOrg();
		const form = await createForm(org.id, {
			name: "Bar",
			from: `hola@${org.domain}`,
			design: {
				display: "bar",
				bar_position: "bottom",
				bar_tone: "accent",
				border: "none",
				logo_shape: "circle",
				button_style: "outline",
				overlay: "sideways",
			},
		});
		expect(form.design).toMatchObject({
			bar_position: "bottom",
			bar_style: "floating",
			bar_tone: "accent",
			border: "none",
			logo_shape: "circle",
			button_style: "outline",
			overlay: "dim",
			width: "regular",
		});
		const { html } = await formEmbed(form);
		expect(html).toContain("bottom:0");
		expect(html).toContain("@keyframes mr-rise");
		expect(html).toContain("border:0;");
	});
});
