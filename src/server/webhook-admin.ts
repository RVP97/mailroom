import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { orgOf } from "./brands";
import { db, schema } from "./db";
import { notFound, validation } from "./errors";
import { iso } from "./time";
import { forgetHooks, INBOX_EVENTS, newSecret, WEBHOOK_EVENTS } from "./webhooks";

const input = z.object({
	url: z
		.string()
		.url()
		.refine(
			(u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u),
			"the URL must use https",
		),
	events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
	enabled: z.boolean().optional(),
	/** Only this agent inbox's conversation events (inbox.*). */
	inbox_id: z.string().nullish(),
});

/** An inbox's own webhook takes only conversation events, and only of an inbox of the
 * organization's. */
async function checkInbox(organizationId: string, inboxId: string, events: string[]) {
	const inbox = await db
		.select({ brand: schema.inboxes.organization_id })
		.from(schema.inboxes)
		.where(eq(schema.inboxes.id, inboxId))
		.get();
	if (!inbox || (await orgOf(inbox.brand)) !== organizationId) throw notFound("Inbox");
	const other = events.find((e) => !(INBOX_EVENTS as string[]).includes(e));
	if (other)
		throw validation(
			`events: an inbox's webhook takes only conversation events (${INBOX_EVENTS.join(", ")}), not ${other}`,
		);
}

export async function createWebhook(organizationId: string, raw: unknown) {
	const v = input.parse(raw);
	if (v.inbox_id) await checkInbox(organizationId, v.inbox_id, v.events);
	const row = {
		id: crypto.randomUUID(),
		organization_id: organizationId,
		url: v.url,
		events: v.events,
		secret: newSecret(),
		enabled: v.enabled ?? true,
		inbox_id: v.inbox_id ?? null,
		created_at: iso(),
	};
	await db.insert(schema.webhooks).values(row);
	forgetHooks(organizationId);
	return { object: "webhook", ...row };
}

export async function updateWebhook(organizationId: string, id: string, raw: unknown) {
	const { inbox_id: _ignored, ...v } = input.partial().parse(raw);
	const where = and(
		eq(schema.webhooks.id, id),
		eq(schema.webhooks.organization_id, organizationId),
	);
	const current = await db.select().from(schema.webhooks).where(where).get();
	if (!current) throw notFound("Webhook");
	if (current.inbox_id && v.events) await checkInbox(organizationId, current.inbox_id, v.events);
	const [row] = await db.update(schema.webhooks).set(v).where(where).returning();
	if (!row) throw notFound("Webhook");
	forgetHooks(organizationId);
	const { secret: _s, ...rest } = row;
	return { object: "webhook", ...rest };
}

export async function deleteWebhook(organizationId: string, id: string) {
	const [row] = await db
		.delete(schema.webhooks)
		.where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.organization_id, organizationId)))
		.returning({ id: schema.webhooks.id });
	if (!row) throw notFound("Webhook");
	forgetHooks(organizationId);
}
