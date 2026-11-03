import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { archiveLink, readNdjson, serveArchiveLink, setArchiveEnabled } from "@/server/archive";
import { purge } from "@/server/cron";
import { db, schema } from "@/server/db";
import { createEmails, parseSend } from "@/server/send";
import { fakeOutside, seedOrg, uid } from "./helpers";

const bucket = () => (env as unknown as { INBOUND: R2Bucket }).INBOUND;

const call = (key: string, path: string) =>
	handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			headers: { authorization: `Bearer ${key}` },
		}),
	);

describe("long-term archive", () => {
	it("moves what retention takes to R2 before deleting it, and serves it back", async () => {
		fakeOutside();
		const org = await seedOrg();
		await setArchiveEnabled(org.id, true);
		const old = Date.now() - 120 * 86_400_000;
		const subject = `Archive ${uid()}`;
		const sent = await createEmails(
			org.id,
			Array.from({ length: 3 }, (_, i) =>
				parseSend({
					from: `a@${org.domain}`,
					to: `c${i}@cliente.test`,
					subject,
					html: `<p>Hola ${i}</p>`,
				}),
			),
			{ now: old },
		);
		const ids = sent.map((s) => s.id as string);
		await db
			.update(schema.emails)
			.set({ status: "delivered" })
			.where(eq(schema.emails.organization_id, org.id));
		await db.insert(schema.emailEvents).values({
			id: `ev-${uid()}`,
			email_id: ids[0] as string,
			organization_id: org.id,
			type: "email.delivered",
			at: new Date(old + 60_000).toISOString(),
			recipient: "c0@cliente.test",
		});

		await purge(Date.now());

		expect(
			await db.select().from(schema.emails).where(eq(schema.emails.organization_id, org.id)),
		).toEqual([]);
		const listed = await bucket().list({ prefix: `archive/${org.id}/` });
		const keys = listed.objects.map((o) => o.key).sort();
		const day = new Date(old).toISOString().slice(0, 10);
		expect(keys).toEqual([
			expect.stringMatching(new RegExp(`^archive/${org.id}/bodies/${day}/.+\\.ndjson\\.gz$`)),
			expect.stringMatching(new RegExp(`^archive/${org.id}/emails/${day}/.+\\.ndjson\\.gz$`)),
		]);
		const emails = await readNdjson<{
			id: string;
			subject: string;
			events: { type: string }[];
		}>(await ((await bucket().get(keys[1] as string)) as R2ObjectBody).arrayBuffer());
		expect(emails.map((e) => e.id).sort()).toEqual([...ids].sort());
		expect(emails.find((e) => e.id === ids[0])?.events.map((x) => x.type)).toEqual([
			"email.delivered",
		]);
		const bodies = await readNdjson<{ id: string; html: string }>(
			await ((await bucket().get(keys[0] as string)) as R2ObjectBody).arrayBuffer(),
		);
		expect(bodies.find((b) => b.id === ids[1])?.html).toContain("Hola 1");

		// The API lists and downloads a brand's files, and only its own.
		const { token } = await createKey({
			organizationId: org.id,
			name: "t",
			permission: "full",
		});
		const list = (await (await call(token, "/archive?kind=emails")).json()) as {
			data: { key: string; count: number; kind: string }[];
		};
		expect(list.data).toEqual([
			expect.objectContaining({ key: keys[1], kind: "emails", count: 3 }),
		]);
		const file = await call(
			token,
			`/archive/file?key=${encodeURIComponent(keys[1] as string)}`,
		);
		expect(file.status).toBe(200);
		expect((await readNdjson(await file.arrayBuffer())).length).toBe(3);
		const other = await seedOrg();
		const theirs = await createKey({ organizationId: other.id, name: "t", permission: "full" });
		expect(
			(await call(theirs.token, `/archive/file?key=${encodeURIComponent(keys[1] as string)}`))
				.status,
		).toBe(404);

		// The dashboard's signed link works for an hour.
		const path = new URL(await archiveLink(keys[0] as string), "https://mailroom.test")
			.pathname;
		expect((await serveArchiveLink(path)).status).toBe(200);
		expect((await serveArchiveLink(path, Date.now() + 2 * 3600_000)).status).toBe(404);
		expect(
			(await serveArchiveLink(path.replace(/\/[^/]+\/archive\//, "/xx/archive/"))).status,
		).toBe(404);
	});

	it("is off until the organization turns it on: then rows are only deleted", async () => {
		fakeOutside();
		const org = await seedOrg();
		await createEmails(
			org.id,
			[parseSend({ from: `a@${org.domain}`, to: "c@cliente.test", subject: "s", text: "t" })],
			{ now: Date.now() - 120 * 86_400_000 },
		);
		await purge(Date.now());
		expect(
			await db.select().from(schema.emails).where(eq(schema.emails.organization_id, org.id)),
		).toEqual([]);
		expect((await bucket().list({ prefix: `archive/${org.id}/` })).objects).toEqual([]);
	});

	it("keeps the rows when R2 refuses", async () => {
		fakeOutside();
		const org = await seedOrg();
		await setArchiveEnabled(org.id, true);
		const old = Date.now() - 120 * 86_400_000;
		await createEmails(
			org.id,
			[parseSend({ from: `a@${org.domain}`, to: "c@cliente.test", subject: "s", text: "t" })],
			{ now: old },
		);
		const put = bucket().put;
		bucket().put = (() => Promise.reject(new Error("R2 down"))) as typeof put;
		try {
			await purge(Date.now());
		} finally {
			bucket().put = put;
		}
		expect(
			await db.select().from(schema.emails).where(eq(schema.emails.organization_id, org.id)),
		).toHaveLength(1);
	});
});
