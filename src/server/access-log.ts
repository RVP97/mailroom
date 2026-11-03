import { desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * The access log: who looked up a recipient or let one receive again, in the dashboard, through
 * the API or an assistant (MCP). Browsing emails and stats isn't logged. Kept with the
 * organization (not the brand), newest first.
 */

export type AccessAction = "recipient_lookup" | "suppression_removed" | "unsubscribe_removed";
export type AccessChannel = "dashboard" | "api" | "assistant";

export async function logAccess(e: {
	organizationId: string;
	action: AccessAction;
	subject: string;
	channel: AccessChannel;
	userId?: string | null;
	actor?: string | null;
	now?: number;
}) {
	await db.insert(schema.accessLog).values({
		id: crypto.randomUUID(),
		organization_id: e.organizationId,
		action: e.action,
		subject: e.subject.trim().toLowerCase().slice(0, 320),
		channel: e.channel,
		user_id: e.userId ?? null,
		actor: e.actor ?? null,
		created_at: iso(e.now ?? Date.now()),
	});
}

export async function listAccessLog(organizationId: string, limit = 200) {
	return db
		.select()
		.from(schema.accessLog)
		.where(eq(schema.accessLog.organization_id, organizationId))
		.orderBy(desc(schema.accessLog.created_at))
		.limit(limit);
}

/** The API key's name, for the log's «who». */
export async function keyName(id: string) {
	const row = await db
		.select({ name: schema.apiKeys.name })
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.id, id))
		.get();
	return row ? `API key «${row.name}»` : "API key";
}
