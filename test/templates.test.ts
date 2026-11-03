import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { db, schema } from "@/server/db";
import { storedContent } from "@/server/send";
import { fill, htmlToText } from "@/server/templates";
import { fakeOutside, seedOrg } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const call = (key: string, method: string, path: string, body?: unknown) =>
	handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			method,
			headers: {
				authorization: `Bearer ${key}`,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);

async function orgWithKey() {
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission: "full" });
	return { ...org, token };
}

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

describe("templates", () => {
	it("fills placeholders, keeps unknown ones, and takes inline fallbacks", () => {
		expect(
			fill("Hi {{{NAME}}}, {{{ FIRST_NAME|there }}}! {{{RESEND_UNSUBSCRIBE_URL}}}", {
				NAME: "Ana",
			}),
		).toBe("Hi Ana, there! {{{RESEND_UNSUBSCRIBE_URL}}}");
		expect(fill("{{{contact.first_name}}}", { "contact.first_name": "Luis" })).toBe("Luis");
		expect(htmlToText('<p>Hola <b>Ana</b></p><p><a href="https://x.test/a">Ver</a></p>')).toBe(
			"Hola Ana\n\nVer (https://x.test/a)",
		);
	});

	it("creates, publishes and sends a template with variables, by id or alias", async () => {
		const aws = fakeOutside();
		const org = await orgWithKey();
		const created = await call(org.token, "POST", "/templates", {
			name: "Welcome",
			alias: "welcome",
			from: `Hotel <hola@${org.domain}>`,
			subject: "Welcome, {{{NAME}}}",
			html: "<p>Hi {{{NAME}}}, you have {{{NIGHTS}}} nights.</p>",
			variables: [
				{ key: "NAME", type: "string" },
				{ key: "NIGHTS", type: "number", fallback_value: 1 },
			],
		});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };

		// A draft can't be sent yet.
		const early = await call(org.token, "POST", "/emails", {
			to: "ana@guest.test",
			template: { id: "welcome", variables: { NAME: "Ana" } },
		});
		expect(early.status).toBe(422);
		expect(((await early.json()) as { message: string }).message).toContain("isn't published");

		expect((await call(org.token, "POST", `/templates/${id}/publish`)).status).toBe(200);

		const missing = await call(org.token, "POST", "/emails", {
			to: "ana@guest.test",
			template: { id: "welcome" },
		});
		expect(((await missing.json()) as { message: string }).message).toContain(
			"template.variables.NAME is required",
		);

		const sent = await call(org.token, "POST", "/emails", {
			to: "ana@guest.test",
			template: { id: "welcome", variables: { NAME: "Ana" } },
		});
		expect(sent.status).toBe(200);
		const { id: emailId } = (await sent.json()) as { id: string };
		const raw = rawOf(aws.sends[0] as never);
		expect(raw).toContain("Subject: Welcome, Ana");
		expect(raw).toContain(`From: "Hotel" <hola@${org.domain}>`);
		const stored = await storedContent(emailId);
		expect(stored?.content.html).toBe("<p>Hi Ana, you have 1 nights.</p>");
		expect(stored?.content.text).toBe("Hi Ana, you have 1 nights.");
		const row = await db
			.select({ template_id: schema.emails.template_id })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		expect(row?.template_id).toBe(id);

		// html with a template is refused; the send's own subject wins.
		const both = await call(org.token, "POST", "/emails", {
			to: "ana@guest.test",
			html: "<p>x</p>",
			template: { id },
		});
		expect(both.status).toBe(422);
		const own = await call(org.token, "POST", "/emails/batch", [
			{
				to: "luis@guest.test",
				subject: "Custom",
				template: { id, variables: { NAME: "Luis", NIGHTS: "3" } },
			},
		]);
		expect(own.status).toBe(200);
	});

	it("keeps edits in the draft until they're published", async () => {
		fakeOutside();
		const org = await orgWithKey();
		const res = await call(org.token, "POST", "/templates", {
			name: "Receipt",
			subject: "Receipt",
			html: "<p>v1</p>",
			publish: true,
		});
		const { id } = (await res.json()) as { id: string };
		await call(org.token, "PATCH", `/templates/${id}`, { html: "<p>v2</p>" });
		const t = (await (await call(org.token, "GET", `/templates/${id}`)).json()) as Record<
			string,
			unknown
		>;
		expect(t).toMatchObject({
			status: "published",
			has_unpublished_changes: true,
			html: "<p>v2</p>",
		});
		const sent = await call(org.token, "POST", "/emails", {
			from: `a@${org.domain}`,
			to: "x@guest.test",
			template: { id },
		});
		const { id: emailId } = (await sent.json()) as { id: string };
		expect((await storedContent(emailId))?.content.html).toBe("<p>v1</p>");

		const dup = await call(org.token, "POST", `/templates/${id}/duplicate`);
		expect(dup.status).toBe(201);
		const list = (await (await call(org.token, "GET", "/templates")).json()) as {
			data: { name: string; status: string }[];
		};
		expect(
			list.data
				.map((d) => [d.name, d.status])
				.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		).toEqual([
			["Receipt", "published"],
			["Receipt (copy)", "draft"],
		]);
		expect((await call(org.token, "DELETE", `/templates/${id}`)).status).toBe(200);
		expect((await call(org.token, "GET", `/templates/${id}`)).status).toBe(404);
	});

	it("refuses reserved, repeated and taken names", async () => {
		const org = await orgWithKey();
		const reserved = await call(org.token, "POST", "/templates", {
			name: "x",
			html: "x",
			variables: [{ key: "EMAIL", type: "string" }],
		});
		expect(reserved.status).toBe(422);
		const twice = await call(org.token, "POST", "/templates", {
			name: "x",
			html: "x",
			variables: [
				{ key: "A", type: "string" },
				{ key: "A", type: "number" },
			],
		});
		expect(twice.status).toBe(422);
		await call(org.token, "POST", "/templates", { name: "a", alias: "same", html: "x" });
		const taken = await call(org.token, "POST", "/templates", {
			name: "b",
			alias: "same",
			html: "x",
		});
		expect(taken.status).toBe(409);
	});
});
