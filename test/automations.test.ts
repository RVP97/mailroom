import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { onEngaged, runAutomations, sameLink } from "@/server/automations";
import { db, schema } from "@/server/db";
import { storedContent } from "@/server/send";
import { fakeOutside, seedOrg } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const call = async (key: string, method: string, path: string, body?: unknown) => {
	const res = await handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			method,
			headers: {
				authorization: `Bearer ${key}`,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const emailsTo = (address: string) =>
	db
		.select()
		.from(schema.emails)
		.where(eq(schema.emails.source, "automation"))
		.then((rows) => rows.filter((e) => e.to.includes(address)));

beforeEach(async () => {
	await db.delete(schema.emailBodies);
	await db.delete(schema.emails);
});

async function setUp() {
	fakeOutside();
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission: "full" });
	const tpl = await call(token, "POST", "/templates", {
		name: "Welcome",
		alias: "welcome",
		from: `Hotel <hola@${org.domain}>`,
		subject: "Welcome, {{{FIRST_NAME|friend}}}",
		html: "<p>Hi {{{FIRST_NAME|there}}}, room {{{event.room|soon}}}. <a href='{{{UNSUBSCRIBE_URL}}}'>Leave</a></p>",
		publish: true,
	});
	expect(tpl.status).toBe(201);
	const seg = (await call(token, "POST", "/segments", { name: "Guests" })).body.id as string;
	return { ...org, token, seg };
}

describe("automations", () => {
	it("welcomes new contacts of a segment, waits, and ends the run when they didn't open", async () => {
		const org = await setUp();
		const draft = await call(org.token, "POST", "/automations", {
			name: "Welcome series",
			trigger: { type: "contact.created", segment_id: org.seg },
			steps: [],
			status: "active",
		});
		expect(draft.status).toBe(422); // nothing to send
		const made = await call(org.token, "POST", "/automations", {
			name: "Welcome series",
			trigger: { type: "contact.created", segment_id: org.seg },
			steps: [
				{ type: "send", template_id: "welcome" },
				{ type: "wait", days: 1 },
				{ type: "condition", engaged: "opened" },
				{ type: "send", template_id: "welcome", subject: "Did you see this?" },
			],
			status: "active",
		});
		expect(made.status).toBe(201);
		const id = made.body.id as string;

		await call(org.token, "POST", "/contacts", {
			email: "ana@guest.test",
			first_name: "Ana",
			segments: [org.seg],
		});
		await call(org.token, "POST", "/contacts", { email: "outside@guest.test" });

		const now = Date.now();
		expect(await runAutomations(now)).toBe(1);
		const [first] = await emailsTo("ana@guest.test");
		expect(first).toMatchObject({ subject: "Welcome, Ana", status: "queued" });
		expect(first?.unsubscribe_group).toBe("broadcasts");
		expect((await storedContent(first?.id as string))?.content.html).toContain(
			"Hi Ana, room soon",
		);
		expect(await emailsTo("outside@guest.test")).toHaveLength(0);

		// Waiting a day: nothing yet.
		expect(await runAutomations(now + 60_000)).toBe(0);
		expect(await runAutomations(now + 86_400_000 + 60_000)).toBe(1);
		expect(await emailsTo("ana@guest.test")).toHaveLength(1);
		const runs = await call(org.token, "GET", `/automations/${id}/runs`);
		expect(runs.body.counts).toMatchObject({ exited: 1, active: 0 });
	});

	it("starts on an app's event, with its data in the email, as often as it comes", async () => {
		const org = await setUp();
		await call(org.token, "POST", "/automations", {
			name: "Booking",
			trigger: { type: "event", event: "booking.created" },
			steps: [{ type: "send", template_id: "welcome", subject: "Room {{{event.room}}}" }],
			reentry: true,
			status: "active",
		});
		const ev = await call(org.token, "POST", "/events", {
			event: "booking.created",
			email: "luis@guest.test",
			data: { room: "204" },
		});
		expect(ev).toMatchObject({ status: 202, body: { started: 1 } });
		await call(org.token, "POST", "/events", {
			event: "booking.created",
			email: "luis@guest.test",
			data: { room: "<i>305</i>" },
		});
		const none = await call(org.token, "POST", "/events", {
			event: "nobody.listens",
			email: "luis@guest.test",
		});
		expect(none.body).toMatchObject({ started: 0 });
		expect(await runAutomations()).toBe(2);
		const sent = await emailsTo("luis@guest.test");
		expect(sent.map((e) => e.subject).sort()).toEqual(["Room 204", "Room <i>305</i>"]);
		const escaped = sent.find((e) => e.subject.includes("305"));
		expect((await storedContent(escaped?.id as string))?.content.html).toContain(
			"room &#60;i&#62;305",
		);

		// Unsubscribed contacts leave before the next email.
		await call(org.token, "PATCH", "/contacts/luis@guest.test", { unsubscribed: true });
		await call(org.token, "POST", "/events", {
			event: "booking.created",
			email: "luis@guest.test",
		});
		expect(await runAutomations()).toBe(1);
		expect(await emailsTo("luis@guest.test")).toHaveLength(2);
	});

	it("branches: yes goes on below, no takes its own steps (segments and properties too)", async () => {
		const org = await setUp();
		const prop = await call(org.token, "POST", "/contact-properties", { key: "stage" });
		expect(prop.status).toBe(201);
		const vip = (await call(org.token, "POST", "/segments", { name: "VIP" })).body.id as string;
		const made = await call(org.token, "POST", "/automations", {
			name: "Onboarding",
			trigger: { type: "contact.created" },
			steps: [
				{ type: "send", template_id: "welcome" },
				{ type: "wait", hours: 2 },
				{
					type: "condition",
					segment_id: vip,
					no: [
						{ type: "property", key: "stage", value: "regular" },
						{ type: "send", template_id: "welcome", subject: "For everyone" },
					],
				},
				{ type: "segment", action: "remove", segment_id: org.seg },
				{ type: "send", template_id: "welcome", subject: "For VIPs" },
			],
			status: "active",
		});
		expect(made.status).toBe(201);
		const steps = made.body.steps as { no?: unknown[] }[];
		expect(steps[2]?.no).toHaveLength(2);

		await call(org.token, "POST", "/contacts", {
			email: "vip@guest.test",
			segments: [vip, org.seg],
		});
		await call(org.token, "POST", "/contacts", { email: "reg@guest.test" });
		const now = Date.now();
		expect(await runAutomations(now)).toBe(2);
		expect(await runAutomations(now + 3 * 3_600_000)).toBe(2);

		const vipMail = (await emailsTo("vip@guest.test")).map((e) => e.subject).sort();
		expect(vipMail).toEqual(["For VIPs", "Welcome, friend"]);
		const regMail = (await emailsTo("reg@guest.test")).map((e) => e.subject).sort();
		expect(regMail).toEqual(["For everyone", "Welcome, friend"]);

		const reg = await call(org.token, "GET", "/contacts/reg@guest.test");
		expect(reg.body.properties).toMatchObject({ stage: "regular" });
		const inSeg = await db
			.select()
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.segment_id, org.seg));
		expect(inSeg).toHaveLength(0);

		const runs = await call(org.token, "GET", `/automations/${made.body.id}/runs`);
		expect(runs.body.counts).toMatchObject({ done: 2, active: 0 });

		// Too deep, or a broken branch, is refused.
		const bad = await call(org.token, "POST", "/automations", {
			name: "Bad",
			trigger: { type: "contact.created" },
			steps: [{ type: "condition", engaged: "opened", no: [{ type: "wait" }] }],
		});
		expect(bad.status).toBe(422);
	});

	it("starts when a contact opens a broadcast or clicks one of its links", async () => {
		const org = await setUp();
		const b = await call(org.token, "POST", "/broadcasts", {
			name: "Launch",
			from: `Hotel <hola@${org.domain}>`,
			subject: "Hi",
			html: "<p>Hi</p>",
		});
		const broadcast = b.body.id as string;
		await call(org.token, "POST", "/automations", {
			name: "Clicked pricing",
			trigger: { type: "email.clicked", link: "https://hotel.test/pricing" },
			steps: [{ type: "send", template_id: "welcome", subject: "About pricing" }],
			status: "active",
		});
		await call(org.token, "POST", "/automations", {
			name: "Opened launch",
			trigger: { type: "email.opened", broadcast_id: broadcast },
			steps: [{ type: "send", template_id: "welcome", subject: "Thanks for reading" }],
			status: "active",
		});
		await call(org.token, "POST", "/contacts", { email: "eva@guest.test" });
		const email = {
			organization_id: org.id,
			broadcast_id: broadcast,
			to: ["Eva <eva@guest.test>"],
		};
		expect(await onEngaged(email, "clicked", "https://hotel.test/about")).toBe(0);
		expect(await onEngaged(email, "clicked", "https://Hotel.test/pricing/?utm=x")).toBe(1);
		expect(await onEngaged(email, "opened", null)).toBe(1);
		// Once each (they don't start again unless set to).
		expect(await onEngaged(email, "opened", null)).toBe(0);
		expect(await onEngaged({ ...email, broadcast_id: null }, "opened", null)).toBe(0);
		expect(await onEngaged({ ...email, to: ["nobody@guest.test"] }, "opened", null)).toBe(0);
		await runAutomations();
		const sent = (await emailsTo("eva@guest.test")).map((e) => e.subject).sort();
		expect(sent).toEqual(["About pricing", "Thanks for reading"]);
		expect(sameLink("https://a.test/x/", "https://A.test/x")).toBe(true);
	});
});
