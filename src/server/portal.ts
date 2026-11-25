import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { sha256Hex } from "./aws/sigv4";
import { companyForEmail } from "./companies";
import { db, schema } from "./db";
import { ApiError } from "./errors";
import { publicUrl, shownHere } from "./public-host";
import { getPublicPagesSettings } from "./status-page";
import { sendSystemEmail } from "./system-email";
import { iso } from "./time";

/**
 * B2B Customer Support Portal (/portal/<slug>):
 * Opt-in per org, slug-only, rate-limited passwordless magic-link login for customers & Enterprise
 * B2B companies. Magic links are single-use (30m) and exchange into a separate HttpOnly; Secure;
 * SameSite=Lax session cookie (24h). Shows all open & resolved tickets for the person (and their
 * Company teammates via SQL subquery), linked GitHub/Linear issues, and allows replying or opening
 * new tickets.
 */

const COOKIE_PREFIX = "mr_portal_";
const LOGIN_TOKEN_TTL_MS = 30 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_LOGIN_TOKENS_PER_HOUR = 5;

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };

async function checkPortalRateLimit(req: Request, orgId: string, email: string): Promise<boolean> {
	const limiter = (env as unknown as Record<string, Limiter | undefined>).PORTAL_LOGIN_LIMIT;
	if (!limiter) return true;
	const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
	const [ipRes, emailRes] = await Promise.all([
		limiter.limit({ key: `ip:${ip}` }),
		limiter.limit({ key: `email:${orgId}:${email}` }),
	]);
	return ipRes.success && emailRes.success;
}

const esc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(req: Request, name: string): string | null {
	const raw = req.headers.get("cookie") ?? "";
	for (const part of raw.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

async function resolveOrg(slug: string) {
	const clean = slug.trim().toLowerCase();
	return (
		(await db
			.select({
				id: schema.organization.id,
				name: schema.organization.name,
				slug: schema.organization.slug,
			})
			.from(schema.organization)
			.where(eq(schema.organization.slug, clean))
			.get()) ?? null
	);
}

/** Issue a 30-minute single-use passwordless magic-link token for a customer (scoped to them + their B2B Company). */
export async function issuePortalLink(
	organizationId: string,
	slug: string,
	rawEmail: string,
	o: { sendEmail?: boolean; now?: number } = {},
) {
	const email = rawEmail.trim().toLowerCase();
	if (!email?.includes("@")) throw new Error("Enter a valid email address");
	const now = o.now ?? Date.now();

	// Enforce per-email hourly token cap even when Cloudflare rate-limit bindings aren't attached.
	const hourAgo = iso(now - 60 * 60_000);
	const recent = await db
		.select({ count: sql<number>`count(*)` })
		.from(schema.portalTokens)
		.where(
			and(
				eq(schema.portalTokens.organization_id, organizationId),
				eq(schema.portalTokens.email, email),
				eq(schema.portalTokens.kind, "login"),
				gte(schema.portalTokens.created_at, hourAgo),
			),
		)
		.get();
	if (Number(recent?.count ?? 0) >= MAX_LOGIN_TOKENS_PER_HOUR) {
		throw new ApiError(
			429,
			"rate_limit_exceeded",
			"Too many sign-in links requested for this email. Please wait an hour and try again.",
		);
	}

	const token = randomToken();
	const hash = await sha256Hex(token);
	const company = await companyForEmail(organizationId, email).catch(() => null);
	await db.insert(schema.portalTokens).values({
		token_hash: hash,
		organization_id: organizationId,
		kind: "login",
		email,
		company_id: company?.id ?? null,
		expires_at: iso(now + LOGIN_TOKEN_TTL_MS),
		created_at: iso(now),
	});
	const link = `${publicUrl().replace(/\/$/, "")}/portal/${encodeURIComponent(slug)}?token=${token}`;
	if (o.sendEmail !== false) {
		await sendSystemEmail({
			to: email,
			subject: "Your support portal sign-in link",
			text: `Sign in to view and reply to your support tickets:\n\n${link}\n\nThis single-use link expires in 30 minutes.`,
			html: `<p>Sign in to view and reply to your support tickets:</p><p><a href="${esc(link)}">Open Support Portal</a></p><p style="color:#666;font-size:13px">This single-use link expires in 30 minutes.</p>`,
		}).catch(() => {});
	}
	return { token, link, email, company_id: company?.id ?? null };
}

async function sessionFor(req: Request, organizationId: string, now: number) {
	const token = readCookie(req, `${COOKIE_PREFIX}${organizationId}`);
	if (!token) return null;
	const hash = await sha256Hex(token);
	const row = await db
		.select()
		.from(schema.portalTokens)
		.where(
			and(
				eq(schema.portalTokens.token_hash, hash),
				eq(schema.portalTokens.organization_id, organizationId),
				eq(schema.portalTokens.kind, "session"),
			),
		)
		.get();
	if (!row || Date.parse(row.expires_at) <= now) return null;
	return row;
}

/** SQL filter matching tickets belonging to the signed-in email or any teammate in their B2B Company (subquery avoids D1's 100-param limit). */
function visibleTicketFilter(organizationId: string, email: string, companyId: string | null) {
	const clean = email.toLowerCase();
	if (!companyId) {
		return or(
			eq(schema.conversations.contact_address, clean),
			eq(schema.conversations.visitor_email, clean),
		);
	}
	const companyEmails = db
		.select({ email: schema.contacts.email })
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, organizationId),
				eq(schema.contacts.company_id, companyId),
			),
		);
	return or(
		eq(schema.conversations.contact_address, clean),
		eq(schema.conversations.visitor_email, clean),
		inArray(schema.conversations.contact_address, companyEmails),
		inArray(schema.conversations.visitor_email, companyEmails),
	);
}

function layout(title: string, body: string) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#111215;--muted:#63666f;--line:rgba(17,18,21,.09);--accent:#3b5bdb}
@media(prefers-color-scheme:dark){:root{--bg:#0e0f12;--card:#15161b;--fg:#f4f5f7;--muted:#989ca8;--line:rgba(255,255,255,.09);--accent:#6b8cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
.wrap{max-width:780px;margin:0 auto;padding:42px 20px 80px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:22px;letter-spacing:-.02em}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px}
input,textarea{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-size:14px;margin-top:6px}
button{height:36px;padding:0 14px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:500 13.5px inherit;cursor:pointer}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line);text-decoration:none;color:inherit}.row:first-child{border-top:0}
.pill{font-size:11.5px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);text-transform:capitalize}
.pill.open{color:#f59e0b}.pill.resolved{color:#10b981}
.msg{padding:12px 14px;border-radius:10px;border:1px solid var(--line);margin-bottom:10px;background:var(--bg)}
.msg.team{border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.muted{color:var(--muted);font-size:13.5px}
</style></head><body><div class="wrap">${body}</div></body></html>`,
		{ headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
	);
}

/** Public handler mounted at /portal/<slug>… */
export async function handlePortalPage(request: Request, now = Date.now()): Promise<Response> {
	const url = new URL(request.url);
	const m =
		/^\/portal\/([A-Za-z0-9_-]{1,80})(?:\/(login|logout|new)|\/t\/([A-Za-z0-9_-]+)(?:\/(reply))?)?\/?$/.exec(
			url.pathname,
		);
	if (!m?.[1]) return new Response("Not found", { status: 404 });
	const slug = m[1];
	const action = m[2] ?? null;
	const ticketId = m[3] ?? null;
	const ticketAction = m[4] ?? null;

	const org = await resolveOrg(slug);
	if (!org || !shownHere(org.id)) return new Response("Portal not found", { status: 404 });
	const pages = await getPublicPagesSettings(org.id);
	if (!pages.portal_enabled) return new Response("Portal not found", { status: 404 });
	const portalBase = `/portal/${encodeURIComponent(org.slug ?? slug)}`;
	const cookieName = `${COOKIE_PREFIX}${org.id}`;

	// Exchange single-use magic-link token -> separate HttpOnly; Secure; SameSite=Lax session cookie
	const tokenParam = url.searchParams.get("token");
	if (tokenParam && request.method === "GET") {
		const hash = await sha256Hex(tokenParam);
		const [consumed] = await db
			.delete(schema.portalTokens)
			.where(
				and(
					eq(schema.portalTokens.token_hash, hash),
					eq(schema.portalTokens.organization_id, org.id),
					eq(schema.portalTokens.kind, "login"),
				),
			)
			.returning();
		if (!consumed || Date.parse(consumed.expires_at) <= now) {
			return layout(
				`${org.name} Support Portal`,
				`<div class="card"><h2>Link expired or already used</h2><p class="muted">Request a fresh sign-in link below.</p><p><a href="${portalBase}">Back to sign in</a></p></div>`,
			);
		}
		const sessionToken = randomToken();
		await db.insert(schema.portalTokens).values({
			token_hash: await sha256Hex(sessionToken),
			organization_id: org.id,
			kind: "session",
			email: consumed.email,
			company_id: consumed.company_id,
			expires_at: iso(now + SESSION_TTL_MS),
			created_at: iso(now),
		});
		return new Response(null, {
			status: 302,
			headers: {
				location: portalBase,
				"set-cookie": `${cookieName}=${encodeURIComponent(sessionToken)}; Path=/portal/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
			},
		});
	}

	if (action === "logout" && request.method === "POST") {
		const curToken = readCookie(request, cookieName);
		if (curToken) {
			await db
				.delete(schema.portalTokens)
				.where(
					and(
						eq(schema.portalTokens.token_hash, await sha256Hex(curToken)),
						eq(schema.portalTokens.organization_id, org.id),
						eq(schema.portalTokens.kind, "session"),
					),
				);
		}
		return new Response(null, {
			status: 302,
			headers: {
				location: portalBase,
				"set-cookie": `${cookieName}=; Path=/portal/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
			},
		});
	}

	if (action === "login" && request.method === "POST") {
		const fd = await request.formData();
		const email = String(fd.get("email") ?? "")
			.trim()
			.toLowerCase();
		if (!email?.includes("@")) {
			return layout(
				`${org.name} Support Portal`,
				`<div class="card"><p>Please enter a valid email.</p><a href="${portalBase}">Try again</a></div>`,
			);
		}
		if (!(await checkPortalRateLimit(request, org.id, email))) {
			return new Response("Too many requests — please try again in a minute.", {
				status: 429,
				headers: { "retry-after": "60" },
			});
		}
		try {
			await issuePortalLink(org.id, org.slug ?? slug, email, { now });
		} catch (err) {
			if (err instanceof ApiError && err.status === 429) {
				return new Response(err.message, {
					status: 429,
					headers: { "retry-after": "3600" },
				});
			}
			throw err;
		}
		return layout(
			`${org.name} Support Portal`,
			`<header><h1>${esc(org.name)} Support</h1></header><div class="card"><h2>Check your inbox</h2><p class="muted">We sent a single-use sign-in link to <b>${esc(email)}</b>. Click it to view your open and past tickets.</p></div>`,
		);
	}

	const sess = await sessionFor(request, org.id, now);
	if (!sess) {
		return layout(
			`${org.name} Support Portal`,
			`<header><h1>${esc(org.name)} Support Portal</h1></header>
<div class="card">
  <h2 style="margin-top:0">Sign in to view your tickets</h2>
  <p class="muted">Enter your work email and we'll send you a one-click sign-in link. B2B accounts can view tickets across their whole company.</p>
  <form method="post" action="${portalBase}/login">
    <label for="pe">Work email</label>
    <input id="pe" name="email" type="email" required placeholder="you@company.com">
    <div style="margin-top:12px"><button type="submit">Email me a sign-in link</button></div>
  </form>
</div>`,
		);
	}

	const ticketFilter = visibleTicketFilter(org.id, sess.email, sess.company_id);

	// Create a new support ticket from portal
	if (action === "new" && request.method === "POST") {
		const fd = await request.formData();
		const subject = String(fd.get("subject") ?? "")
			.trim()
			.slice(0, 200);
		const message = String(fd.get("message") ?? "")
			.trim()
			.slice(0, 8000);
		if (!subject || !message)
			return new Response("Subject and message required", { status: 400 });
		const at = iso(now);
		const defInbox = await db
			.select({ id: schema.inboxes.id })
			.from(schema.inboxes)
			.where(eq(schema.inboxes.organization_id, org.id))
			.limit(1)
			.get();
		const convId = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
		await db.insert(schema.conversations).values({
			id: convId,
			organization_id: org.id,
			inbox_id: defInbox?.id ?? null,
			channel: "chat",
			subject,
			contact: sess.email,
			contact_address: sess.email,
			visitor_email: sess.email,
			status: "open",
			messages: 1,
			snippet: message.slice(0, 180),
			last_message_at: at,
			last_inbound_at: at,
			created_at: at,
			updated_at: at,
		});
		await db.insert(schema.chatMessages).values({
			id: `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: org.id,
			conversation_id: convId,
			inbox_id: defInbox?.id ?? null,
			author: "visitor",
			author_id: null,
			author_name: sess.email,
			text: message,
			via: "widget",
			created_at: at,
		});
		const { notifyInboxChange } = await import("./inbox-live");
		await notifyInboxChange(org.id, { kind: "chat", conversation_id: convId });
		return new Response(null, {
			status: 302,
			headers: { location: `${portalBase}/t/${convId}` },
		});
	}

	// Single ticket view or reply
	if (ticketId) {
		const conv = await db
			.select()
			.from(schema.conversations)
			.where(
				and(
					eq(schema.conversations.id, ticketId),
					eq(schema.conversations.organization_id, org.id),
					ticketFilter,
				),
			)
			.get();
		if (!conv) return new Response("Ticket not found", { status: 404 });

		if (ticketAction === "reply" && request.method === "POST") {
			const fd = await request.formData();
			const message = String(fd.get("message") ?? "")
				.trim()
				.slice(0, 8000);
			if (message) {
				const at = iso(now);
				await db.insert(schema.chatMessages).values({
					id: `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
					organization_id: org.id,
					conversation_id: conv.id,
					inbox_id: conv.inbox_id ?? null,
					author: "visitor",
					author_id: null,
					author_name: sess.email,
					text: message,
					via: "widget",
					created_at: at,
				});
				await db
					.update(schema.conversations)
					.set({
						status: "open",
						messages: sql`${schema.conversations.messages} + 1`,
						snippet: message.slice(0, 180),
						last_message_at: at,
						last_inbound_at: at,
						updated_at: at,
					})
					.where(eq(schema.conversations.id, conv.id));
				const { notifyInboxChange } = await import("./inbox-live");
				await notifyInboxChange(org.id, { kind: "chat", conversation_id: conv.id });
			}
			return new Response(null, {
				status: 302,
				headers: { location: `${portalBase}/t/${conv.id}` },
			});
		}

		const [msgs, replies, issues] = await Promise.all([
			db
				.select()
				.from(schema.chatMessages)
				.where(eq(schema.chatMessages.conversation_id, conv.id)),
			db
				.select()
				.from(schema.conversationReplies)
				.where(
					and(
						eq(schema.conversationReplies.conversation_id, conv.id),
						eq(schema.conversationReplies.status, "sent"),
					),
				),
			db
				.select()
				.from(schema.conversationIssues)
				.where(eq(schema.conversationIssues.conversation_id, conv.id)),
		]);
		const timeline = [
			...msgs.map((x) => ({
				from: x.author_name || (x.author === "visitor" ? sess.email : org.name),
				team: x.author !== "visitor",
				text: x.text ?? "",
				at: x.created_at,
			})),
			...replies.map((x) => ({
				from: x.author_name || org.name,
				team: true,
				text: x.text ?? "",
				at: x.sent_at ?? x.created_at,
			})),
		].sort((a, b) => a.at.localeCompare(b.at));

		const issuesBlock = issues.length
			? `<div class="card"><b>Linked engineering issues</b><ul style="margin:8px 0 0;padding-left:18px">${issues
					.map(
						(i) =>
							`<li><span class="pill ${esc(i.status)}">${esc(i.status)}</span> ${esc(i.title)}</li>`,
					)
					.join("")}</ul></div>`
			: "";

		return layout(
			`${conv.subject} · ${org.name}`,
			`<header><div><a href="${portalBase}" class="muted">← All tickets</a><h1 style="margin-top:4px">${esc(conv.subject)}</h1></div><span class="pill ${esc(conv.status)}">${esc(conv.status)}</span></header>
${issuesBlock}
<div class="card">${timeline.length ? timeline.map((t) => `<div class="msg${t.team ? " team" : ""}"><b>${esc(t.from)}</b> <span class="muted">· ${esc(new Date(t.at).toLocaleString())}</span><p style="margin:6px 0 0;white-space:pre-wrap">${esc(t.text)}</p></div>`).join("") : `<p class="muted">${esc(conv.snippet ?? "No messages yet.")}</p>`}</div>
<div class="card">
  <form method="post" action="${portalBase}/t/${esc(conv.id)}/reply">
    <label for="pm">Add a reply</label>
    <textarea id="pm" name="message" rows="3" required placeholder="Write a message to our support team…"></textarea>
    <div style="margin-top:10px"><button type="submit">Send reply</button></div>
  </form>
</div>`,
		);
	}

	// Ticket list dashboard
	const tickets = await db
		.select()
		.from(schema.conversations)
		.where(and(eq(schema.conversations.organization_id, org.id), ticketFilter))
		.orderBy(desc(schema.conversations.last_message_at))
		.limit(50);

	const rows = tickets.length
		? tickets
				.map(
					(t) => `<a class="row" href="${portalBase}/t/${esc(t.id)}">
  <div><b>${esc(t.subject)}</b><div class="muted">${esc(t.snippet ?? t.contact_address ?? "")}</div></div>
  <span class="pill ${esc(t.status)}">${esc(t.status)}</span>
</a>`,
				)
				.join("")
		: `<p class="muted">No support tickets yet.</p>`;

	return layout(
		`${org.name} Support Portal`,
		`<header>
  <div><h1>${esc(org.name)} Support Portal</h1><div class="muted">Signed in as ${esc(sess.email)}${sess.company_id ? " · Company view enabled" : ""}</div></div>
  <form method="post" action="${portalBase}/logout"><button type="submit" class="btn-ghost">Sign out</button></form>
</header>
<div class="card"><h2 style="margin-top:0">Your tickets (${tickets.length})</h2>${rows}</div>
<div class="card">
  <h2 style="margin-top:0">Open a new ticket</h2>
  <form method="post" action="${portalBase}/new">
    <label for="ns">Subject</label>
    <input id="ns" name="subject" required placeholder="Brief summary of your question">
    <label for="nm" style="display:block;margin-top:10px">Message</label>
    <textarea id="nm" name="message" rows="3" required placeholder="Tell us how we can help…"></textarea>
    <div style="margin-top:12px"><button type="submit">Submit ticket</button></div>
  </form>
</div>`,
	);
}
