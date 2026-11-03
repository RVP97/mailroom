import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { purge } from "@/server/cron";
import { db, schema } from "@/server/db";
import { createEmails, inlineImagesOf, parseSend, storedContent } from "@/server/send";
import { fakeOutside, seedOrg } from "./helpers";

// A 1×1 PNG, and the same logo again under another name.
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const invoice = (domain: string, to: string, filename = "logo.png") =>
	parseSend({
		from: `Facturas <f@${domain}>`,
		to,
		subject: "Su factura",
		html: '<img src="cid:logo" alt="Hotel"><p>Factura</p>',
		attachments: [
			{ filename, content: PNG, content_id: "logo" },
			{ filename: "factura.pdf", content: "JVBERi0=" },
		],
	});

const imagesOf = (orgId: string) =>
	db.select().from(schema.inlineImages).where(eq(schema.inlineImages.organization_id, orgId));

describe("inline images", () => {
	it("keeps each cid: image once per organization and hands it to the preview by its cid", async () => {
		fakeOutside();
		const org = await seedOrg();
		const other = await seedOrg();
		const sent = [];
		for (let i = 0; i < 120; i++)
			sent.push(
				...(await createEmails(org.id, [
					invoice(org.domain, `c${i}@cliente.test`, i % 2 ? "logo.png" : "hotel.png"),
				])),
			);
		await createEmails(other.id, [invoice(other.domain, "x@cliente.test")]);
		expect(await imagesOf(org.id)).toHaveLength(1);
		expect(await imagesOf(other.id)).toHaveLength(1);

		const stored = await storedContent(sent[7]?.id as string);
		const [logo, pdf] = stored?.attachments ?? [];
		expect(logo).toMatchObject({
			content_id: "logo",
			image: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(pdf).toEqual({ filename: "factura.pdf", size: 5 });
		expect(await inlineImagesOf(org.id, stored?.attachments ?? [])).toEqual({
			logo: `data:image/png;base64,${PNG}`,
		});
		// Another organization never gets this one's images, even by the same hash.
		await db
			.delete(schema.inlineImages)
			.where(eq(schema.inlineImages.organization_id, other.id));
		expect(await inlineImagesOf(other.id, stored?.attachments ?? [])).toEqual({});
	});

	it("doesn't keep attachments that aren't inline images", async () => {
		fakeOutside();
		const org = await seedOrg();
		await createEmails(org.id, [
			parseSend({
				from: `f@${org.domain}`,
				to: "c@cliente.test",
				subject: "s",
				html: '<img src="cid:doc">',
				attachments: [
					{ filename: "doc.pdf", content: "JVBERi0=", content_id: "doc" },
					{ filename: "foto.png", content: PNG },
				],
			}),
		]);
		expect(await imagesOf(org.id)).toHaveLength(0);
	});

	it("drops an image no email has used within the retention, and keeps one still in use", async () => {
		fakeOutside();
		const org = await seedOrg();
		const old = Date.now() - 120 * 86_400_000;
		await createEmails(org.id, [invoice(org.domain, "a@cliente.test")], { now: old });
		await purge(Date.now());
		expect(await imagesOf(org.id)).toHaveLength(0);

		await createEmails(org.id, [invoice(org.domain, "b@cliente.test")], { now: old });
		await createEmails(org.id, [invoice(org.domain, "c@cliente.test")]);
		await purge(Date.now());
		expect(await imagesOf(org.id)).toHaveLength(1);
	});
});
