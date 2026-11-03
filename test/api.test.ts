import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { db, schema } from "@/server/db";
import { requestOfEmail, settleRequestLogs } from "@/server/request-logs";
import { fakeOutside, seedOrg } from "./helpers";

// Request logs are written after the answer (setup.ts waits for them); the runner's own
// waitUntil can't hold this file's I/O.
vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const call = (
	key: string | null,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			method,
			headers: {
				...(key ? { authorization: `Bearer ${key}` } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);

async function orgWithKey(permission: "full" | "sending" = "full") {
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission });
	return { ...org, token };
}

describe("API", () => {
	it("answers Resend's error shape without a key or with a bad one", async () => {
		const missing = await call(null, "GET", "/emails");
		expect(missing.status).toBe(401);
		expect(await missing.json()).toMatchObject({ statusCode: 401, name: "missing_api_key" });
		const bad = await call("mr_notarealkeynotarealkey1234", "GET", "/emails");
		expect(await bad.json()).toMatchObject({ name: "invalid_api_key" });
	});

	it("refuses an address with a line break, which would add a header to the message", async () => {
		fakeOutside();
		const org = await orgWithKey();
		for (const field of ["to", "cc", "reply_to"]) {
			const res = await call(org.token, "POST", "/emails", {
				from: `x@${org.domain}`,
				to: "ana@cliente.test",
				subject: "s",
				text: "t",
				[field]: "<ana@cliente.test>\r\nBcc: spy@evil.test",
			});
			expect(res.status).toBe(422);
		}
	});

	it("limits requests without a valid key per IP, and leaves other IPs alone", async () => {
		const ip = { "cf-connecting-ip": "203.0.113.7" };
		const statuses: number[] = [];
		for (let i = 0; i < 21; i++)
			statuses.push(
				(await call("mr_notarealkeynotarealkey1234", "GET", "/emails", undefined, ip))
					.status,
			);
		expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
		const limited = await call(
			"mr_notarealkeynotarealkey1234",
			"GET",
			"/emails",
			undefined,
			ip,
		);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("10");
		expect(await limited.json()).toMatchObject({ name: "rate_limit_exceeded" });
		const other = await call(null, "GET", "/emails", undefined, {
			"cf-connecting-ip": "203.0.113.8",
		});
		expect(other.status).toBe(401);
	});

	it("limits each API key to 100 requests per 10 seconds", async () => {
		const a = await orgWithKey();
		const b = await orgWithKey();
		const statuses = await Promise.all(
			Array.from({ length: 101 }, () =>
				call(a.token, "GET", "/emails").then((r) => r.status),
			),
		);
		expect(statuses.filter((s) => s === 429)).toHaveLength(1);
		expect((await call(b.token, "GET", "/emails")).status).toBe(200);
	});

	it("sends like Resend (POST /emails → { id }) and reads the email back with its events", async () => {
		const aws = fakeOutside();
		const org = await orgWithKey();
		const res = await call(org.token, "POST", "/emails", {
			from: `Hotel <reservas@${org.domain}>`,
			to: ["huesped@cliente.test"],
			subject: "Su reserva",
			html: "<p>Lo esperamos</p>",
		});
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };
		expect(aws.sends).toHaveLength(1);
		const email = (await (await call(org.token, "GET", `/emails/${id}`)).json()) as Record<
			string,
			unknown
		>;
		expect(email).toMatchObject({
			object: "email",
			id,
			status: "sent",
			last_event: "sent",
			html: "<p>Lo esperamos</p>",
		});
		const list = (await (await call(org.token, "GET", "/emails?limit=5")).json()) as {
			data: { id: string }[];
		};
		expect(list.data.map((e) => e.id)).toContain(id);
	});

	it("keeps organizations apart", async () => {
		fakeOutside();
		const a = await orgWithKey();
		const b = await orgWithKey();
		const { id } = (await (
			await call(a.token, "POST", "/emails", {
				from: `x@${a.domain}`,
				to: "y@cliente.test",
				subject: "s",
				text: "t",
			})
		).json()) as { id: string };
		expect((await call(b.token, "GET", `/emails/${id}`)).status).toBe(404);
		const fromOther = await call(b.token, "POST", "/emails", {
			from: `x@${a.domain}`,
			to: "y@cliente.test",
			subject: "s",
			text: "t",
		});
		expect(fromOther.status).toBe(403);
	});

	it("limits a sending key to sending", async () => {
		fakeOutside();
		const org = await orgWithKey("sending");
		expect(
			(
				await call(org.token, "POST", "/emails", {
					from: `x@${org.domain}`,
					to: "y@cliente.test",
					subject: "s",
					text: "t",
				})
			).status,
		).toBe(200);
		const list = await call(org.token, "GET", "/emails");
		expect(list.status).toBe(401);
		expect(await list.json()).toMatchObject({ name: "restricted_api_key" });
	});

	it("takes a batch of 100 with one Idempotency-Key and answers the same ids again", async () => {
		const aws = fakeOutside();
		const org = await orgWithKey();
		const batch = Array.from({ length: 100 }, (_, i) => ({
			from: `x@${org.domain}`,
			to: `c${i}@cliente.test`,
			subject: `n${i}`,
			text: "t",
		}));
		const first = await call(org.token, "POST", "/emails/batch", batch, {
			"idempotency-key": "batch-1",
		});
		expect(first.status).toBe(200);
		const a = (await first.json()) as { data: { id: string }[] };
		expect(a.data).toHaveLength(100);
		const second = (await (
			await call(org.token, "POST", "/emails/batch", batch, { "idempotency-key": "batch-1" })
		).json()) as { data: { id: string }[] };
		expect(second.data).toEqual(a.data);
		expect(aws.sends).toHaveLength(0);
		const rows = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, org.id));
		expect(rows).toHaveLength(100);
		expect(
			(
				await call(
					org.token,
					"POST",
					"/emails/batch",
					Array.from({ length: 101 }, () => batch[0]),
				)
			).status,
		).toBe(422);
	});

	it("schedules, reschedules and cancels", async () => {
		fakeOutside();
		const org = await orgWithKey();
		const at = new Date(Date.now() + 86_400_000).toISOString();
		const { id } = (await (
			await call(org.token, "POST", "/emails", {
				from: `x@${org.domain}`,
				to: "y@cliente.test",
				subject: "s",
				text: "t",
				scheduled_at: at,
			})
		).json()) as { id: string };
		const email = (await (await call(org.token, "GET", `/emails/${id}`)).json()) as {
			status: string;
			scheduled_at: string;
		};
		expect(email.status).toBe("scheduled");
		expect(email.scheduled_at).toBe(at);
		const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
		expect(
			(await call(org.token, "PATCH", `/emails/${id}`, { scheduled_at: later })).status,
		).toBe(200);
		expect((await call(org.token, "POST", `/emails/${id}/cancel`)).status).toBe(200);
		expect((await call(org.token, "POST", `/emails/${id}/cancel`)).status).toBe(409);
	});

	it("manages suppressions", async () => {
		fakeOutside({
			extra: (url, init) =>
				url.pathname.startsWith("/v2/email/suppression/addresses/") &&
				init?.method === "DELETE"
					? Response.json({})
					: undefined,
		});
		const org = await orgWithKey();
		expect(
			(await call(org.token, "POST", "/suppressions", { email: "Nadie@Cliente.test" }))
				.status,
		).toBe(201);
		const list = (await (await call(org.token, "GET", "/suppressions")).json()) as {
			data: { address: string }[];
		};
		expect(list.data.map((s) => s.address)).toEqual(["nadie@cliente.test"]);
		expect((await call(org.token, "DELETE", "/suppressions/nadie%40cliente.test")).status).toBe(
			200,
		);
		const after = (await (await call(org.token, "GET", "/suppressions")).json()) as {
			data: unknown[];
		};
		expect(after.data).toHaveLength(0);
	});

	it("retrieves one suppression, never another organization's", async () => {
		const org = await orgWithKey();
		const other = await orgWithKey();
		await db.insert(schema.suppressions).values({
			organization_id: org.id,
			address: "rebote@cliente.test",
			reason: "bounce",
			detail: "smtp; 550 5.1.1 user unknown",
			email_id: "em_1",
			created_at: "2026-10-01T10:00:00.000Z",
		});
		const res = await call(org.token, "GET", "/suppressions/Rebote%40Cliente.test");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			object: "suppression",
			address: "rebote@cliente.test",
			reason: "bounce",
			detail: "smtp; 550 5.1.1 user unknown",
			email_id: "em_1",
			created_at: "2026-10-01T10:00:00.000Z",
			brand_id: org.id,
		});
		const theirs = await call(other.token, "GET", "/suppressions/rebote%40cliente.test");
		expect(theirs.status).toBe(404);
		expect(await theirs.json()).toMatchObject({ name: "not_found" });
		expect((await call(org.token, "GET", "/suppressions/nadie%40cliente.test")).status).toBe(
			404,
		);
	});

	it("pages a list of more than 100 suppressions", async () => {
		const org = await orgWithKey();
		const rows = Array.from({ length: 130 }, (_, i) => ({
			organization_id: org.id,
			address: `n${String(i).padStart(3, "0")}@cliente.test`,
			reason: i % 3 === 0 ? "complaint" : "bounce",
			created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
		}));
		// D1 binds up to 100 parameters a statement.
		for (let i = 0; i < rows.length; i += 10)
			await db.insert(schema.suppressions).values(rows.slice(i, i + 10));
		const first = (await (await call(org.token, "GET", "/suppressions")).json()) as {
			has_more: boolean;
			data: { address: string }[];
		};
		expect(first.data).toHaveLength(100);
		expect(first.has_more).toBe(true);
		expect(first.data[0]?.address).toBe("n129@cliente.test");
		const second = (await (
			await call(org.token, "GET", "/suppressions?offset=100")
		).json()) as { has_more: boolean; data: { address: string }[] };
		expect(second.data).toHaveLength(30);
		expect(second.has_more).toBe(false);
		const complaints = (await (
			await call(org.token, "GET", "/suppressions?reason=complaint")
		).json()) as { data: unknown[] };
		expect(complaints.data).toHaveLength(44);
		// Every row of the list opens on its own.
		expect((await call(org.token, "GET", "/suppressions/n000%40cliente.test")).status).toBe(
			200,
		);
	});

	it("turns a domain's open and click tracking on and off (Resend's PATCH /domains/:id)", async () => {
		fakeOutside();
		const org = await orgWithKey();
		const res = await call(org.token, "PATCH", `/domains/${org.domainId}`, {
			click_tracking: false,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			object: "domain",
			id: org.domainId,
			open_tracking: true,
			click_tracking: false,
			tracking_domain: null,
		});
		const bad = await call(org.token, "PATCH", `/domains/${org.domainId}`, {
			open_tracking: "yes",
		});
		expect(bad.status).toBe(422);
		const missing = await call(org.token, "PATCH", "/domains/nope", { open_tracking: false });
		expect(missing.status).toBe(404);
	});

	it("logs each call with a key: path, status, client and both bodies, attachments left out", async () => {
		const org = await orgWithKey();
		const res = await call(
			org.token,
			"POST",
			"/suppressions",
			{
				email: "Gone@Example.com",
				attachments: [{ filename: "a.txt", content: "aGVsbG8=" }],
			},
			{ "user-agent": "resend-node:6.1.0" },
		);
		// The client still gets the whole response.
		expect(await res.json()).toMatchObject({
			object: "suppression",
			email: "gone@example.com",
		});
		await call(null, "GET", "/suppressions");
		await settleRequestLogs();
		const r = schema.apiRequests;
		const rows = await db.select().from(r).where(eq(r.organization_id, org.id));
		expect(rows).toHaveLength(1);
		const [log] = rows;
		expect(log).toMatchObject({
			method: "POST",
			path: "/suppressions",
			status: 201,
			user_agent: "resend-node:6.1.0",
		});
		expect(log?.request_body).toContain('"content": "[6 bytes]"');
		expect(log?.request_body).not.toContain("aGVsbG8=");
		expect(log?.response_body).toContain("gone@example.com");
	});

	it("keeps no API key or webhook secret in the logs, though the client gets them", async () => {
		const org = await orgWithKey();
		const keyRes = await call(org.token, "POST", "/api-keys", { name: "app" });
		const { token } = (await keyRes.json()) as { token: string };
		expect(token).toMatch(/^mr_/);
		const hookRes = await call(org.token, "POST", "/webhooks", {
			endpoint: "https://hooks.example.com/mailroom",
			events: ["email.sent"],
		});
		const hook = await hookRes.text();
		await settleRequestLogs();
		const r = schema.apiRequests;
		const rows = await db.select().from(r).where(eq(r.organization_id, org.id));
		const kept = rows.map((x) => `${x.request_body}\n${x.response_body}`).join("\n");
		expect(kept).not.toContain(token);
		expect(kept).toContain("[redacted]");
		const secret = /whsec_[A-Za-z0-9+/=]+/.exec(hook)?.[0];
		if (secret) expect(kept).not.toContain(secret);
	});

	it("links every email of a batch, not only the first, to the call that sent it", async () => {
		fakeOutside();
		const org = await orgWithKey();
		const batch = Array.from({ length: 120 }, (_, i) => ({
			from: `x@${org.domain}`,
			to: `c${i}@cliente.test`,
			subject: `n${i}`,
			text: "t",
		}));
		// Two calls a moment apart: each email finds its own.
		const first = (await (
			await call(org.token, "POST", "/emails/batch", batch.slice(0, 100))
		).json()) as {
			data: { id: string }[];
		};
		const second = (await (await call(org.token, "POST", "/emails", batch[100])).json()) as {
			id: string;
		};
		await settleRequestLogs();
		const e = schema.emails;
		const created = async (id: string) =>
			(await db.select({ at: e.created_at }).from(e).where(eq(e.id, id)).get())?.at as string;
		const last = first.data[99]?.id as string;
		expect(await requestOfEmail(org.id, last, await created(last))).toMatchObject({
			method: "POST",
			path: "/emails/batch",
		});
		expect(await requestOfEmail(org.id, second.id, await created(second.id))).toMatchObject({
			path: "/emails",
		});
		// Another organization's logs never answer.
		const other = await seedOrg();
		expect(await requestOfEmail(other.id, last, await created(last))).toBeNull();
	});
});
