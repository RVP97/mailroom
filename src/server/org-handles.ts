import { and, asc, eq, isNull } from "drizzle-orm";
import { isOrgHandle, newOrgHandle } from "../lib/org-handle";
import { handleOfPath, inOrg, isAppSectionPath, orgPath } from "../lib/org-path";
import { ORG_HEADER, ORG_PARAM } from "../lib/tab-org";
import { accessColumns, roleJoin } from "./access";
import { db, schema } from "./db";
import { baseUrl } from "./env";

/**
 * Organizations' URL handles (src/lib/org-handle.ts) on the server: making them, looking them
 * up, and the links that leave the app (emails, the MCP's answers) built with them.
 */

/** The error text of a failed statement, wherever the driver put it. */
function messageOf(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const e = error as { message?: unknown; cause?: unknown };
	return `${String(e.message ?? "")} ${e.cause ? messageOf(e.cause) : ""}`;
}

/**
 * Runs `write` with a new handle, again with another one if that one was taken in the meantime
 * (the unique index on organization.handle): a few tries, then the error.
 */
export async function withNewHandle<T>(write: (handle: string) => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await write(newOrgHandle());
		} catch (error) {
			if (
				attempt < 4 &&
				/UNIQUE constraint failed: organization\.handle/.test(messageOf(error))
			)
				continue;
			throw error;
		}
	}
}

/**
 * Handles never change, so each isolate remembers the pairs it looked up: a tab's calls and the
 * links in emails cost no extra database trip after the first. Bounded; found ones only.
 */
const handleById = new Map<string, string>();
const idByHandle = new Map<string, string>();
const REMEMBERED = 5000;

function remember(organizationId: string, handle: string) {
	if (handleById.size >= REMEMBERED) {
		handleById.clear();
		idByHandle.clear();
	}
	handleById.set(organizationId, handle);
	idByHandle.set(handle, organizationId);
}

/** For tests: each file starts with nothing remembered. */
export function forgetHandles() {
	handleById.clear();
	idByHandle.clear();
}

/**
 * The handle in `organizationId`'s URLs. One made without it (Better Auth's own insert, before
 * its hook runs) gets one here.
 */
export async function handleOf(organizationId: string): Promise<string | undefined> {
	const known = handleById.get(organizationId);
	if (known) return known;
	const o = schema.organization;
	const row = await db.select({ handle: o.handle }).from(o).where(eq(o.id, organizationId)).get();
	if (!row) return undefined;
	const handle = isOrgHandle(row.handle) ? row.handle : await giveHandle(organizationId);
	if (handle) remember(organizationId, handle);
	return handle;
}

/** Gives an organization that has none its handle (and returns whichever it ends up with). */
export async function giveHandle(organizationId: string): Promise<string | undefined> {
	const o = schema.organization;
	await withNewHandle((handle) =>
		db
			.update(o)
			.set({ handle })
			.where(and(eq(o.id, organizationId), isNull(o.handle))),
	);
	const row = await db.select({ handle: o.handle }).from(o).where(eq(o.id, organizationId)).get();
	return isOrgHandle(row?.handle) ? row.handle : undefined;
}

/** The organization a URL's handle names, if any. */
export async function organizationOfHandle(handle: string): Promise<string | undefined> {
	if (!isOrgHandle(handle)) return undefined;
	const known = idByHandle.get(handle);
	if (known) return known;
	const o = schema.organization;
	const row = await db.select({ id: o.id }).from(o).where(eq(o.handle, handle)).get();
	if (row) remember(row.id, handle);
	return row?.id;
}

/**
 * The organization a request is about, when it names one: the tab's (server function calls
 * carry it in ORG_HEADER, the chat's socket as ?org=), or the handle a page's address starts
 * with. By handle or id. Undefined when it names none (an old link): then the session's.
 * `null`: it names two different ones, refused like one the person isn't in. Membership is the
 * caller's to check, never this.
 */
export function requestedOrg(request: Request): string | null | undefined {
	const url = new URL(request.url);
	const header = request.headers.get(ORG_HEADER)?.trim() || undefined;
	const param = url.searchParams.get(ORG_PARAM)?.trim() || undefined;
	if (header && param && header !== param) return null;
	const named = header ?? param;
	if (named) return named;
	const first = url.pathname.split("/")[1];
	return isOrgHandle(first) ? first : undefined;
}

/** The organization id a request's handle-or-id names (null: none such). */
export async function resolveOrgRef(ref: string): Promise<string | null> {
	if (isOrgHandle(ref)) return (await organizationOfHandle(ref)) ?? null;
	return ref;
}

/**
 * The person's membership in the organization a call is about, with their access columns:
 * `organizationId` (the tab's, else the session's; null: neither). A call that named its
 * organization (`named`, a tab) gets "unavailable" when that one doesn't exist or isn't theirs,
 * never another one's membership, or a change would land in the wrong organization. One that
 * named none falls back to the first they joined (the session's was left or deleted). Null: in no
 * organization at all.
 */
export async function membershipFor(userId: string, organizationId: string | null, named: boolean) {
	if (named && !organizationId) return "unavailable" as const;
	const m = schema.member;
	const query = (id: string | null) =>
		db
			.select({ organizationId: m.organizationId, ...accessColumns })
			.from(m)
			.leftJoin(schema.organizationRole, roleJoin)
			.where(id ? and(eq(m.userId, userId), eq(m.organizationId, id)) : eq(m.userId, userId))
			.orderBy(asc(m.createdAt))
			.limit(1);
	const rows = await query(organizationId);
	if (rows[0]) return rows[0];
	if (named) return "unavailable" as const;
	return organizationId ? ((await query(null))[0] ?? null) : null;
}

/**
 * The answer to a GET or HEAD of an organization page without its organization (/emails: an old
 * link, a bookmark, an email from before handles): a 307 to the same page and query in the one the
 * person last used. Null for anything else, and signed out (it goes on to sign-in as before, and
 * comes back to this address after).
 */
export async function redirectToLastUsed(
	request: Request,
	lastUsed: (request: Request) => Promise<string | undefined> = lastUsedHandle,
): Promise<Response | null> {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const url = new URL(request.url);
	if (handleOfPath(url.pathname) || !isAppSectionPath(url.pathname)) return null;
	// A file (/templates/x.jpg) isn't a page.
	if (url.pathname.split("/").at(-1)?.includes(".")) return null;
	const handle = await lastUsed(request);
	if (!handle) return null;
	return new Response(null, {
		status: 307,
		headers: {
			location: `${orgPath(handle, url.pathname)}${url.search}`,
			"cache-control": "private, no-store",
		},
	});
}

/**
 * The handle of the organization a signed-in person last used (the session's), or of another of
 * theirs: where an address without one (/emails, an old email's link) opens. Undefined signed
 * out or in no organization.
 */
export async function lastUsedHandle(request: Request): Promise<string | undefined> {
	const { auth } = await import("./auth");
	const session = await auth()
		.api.getSession({ headers: request.headers })
		.catch(() => null);
	if (!session) return undefined;
	const m = schema.member;
	const rows = await db
		.select({ id: m.organizationId, joined: m.createdAt })
		.from(m)
		.where(eq(m.userId, session.user.id))
		.all();
	if (!rows.length) return undefined;
	const active = session.session.activeOrganizationId;
	const first = rows.reduce((a, r) => (r.joined < a.joined ? r : a));
	const chosen = rows.find((r) => r.id === active) ?? first;
	return handleOf(chosen.id);
}

/**
 * A full link to `path` in the organization (or brand: its organization) `organizationId`, for
 * emails and the MCP's answers: /received/x → https://mailroom.example.com/k7x2m9/received/x.
 * Person and public pages stay as they are.
 */
export async function appLink(organizationId: string, path: string): Promise<string> {
	const { orgOf } = await import("./brands");
	const handle = await handleOf(await orgOf(organizationId)).catch(() => undefined);
	return `${baseUrl()}${inOrg(handle, path)}`;
}
