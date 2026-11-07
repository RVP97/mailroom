import { eq } from "drizzle-orm";
import { z } from "zod";
import { acceptFor } from "@/lib/chat-files";
import {
	CHAT_LIMITS,
	chatLines,
	chatState,
	designOf,
	fileKindsOf,
	identifyVisitor,
	identityOf,
	linesFor,
	markVisitorSeen,
	originAllowed,
	serveChatFile,
	startChat,
	type VisitorChat,
	visitorChat,
	visitorEnds,
	visitorHistory,
	visitorProfile,
	visitorRates,
	visitorSays,
	visitorSendsFile,
	widgetByKey,
} from "./chat";
import { chatRoom } from "./chat-room";
import widgetSource from "./chat-widget.js?raw";
import { db, schema } from "./db";
import { baseUrl, inboundRetentionDays } from "./env";
import { ApiError } from "./errors";

/**
 * The widget's public endpoints, under /chat/ on Mailroom's own host. No cookies: the visitor's
 * token travels as `Authorization: Bearer mrv_…` (and `?token=` for the WebSocket, which can't
 * set headers). Every call but the script checks the page's Origin against the widget's sites.
 *
 *   GET  /chat/<key>.js            the widget, with its settings (cached 5 minutes)
 *   GET  /chat/<key>/try           a page that only has the widget (to try it)
 *   POST /chat/<key>/start         first message (Turnstile) → token, conversation, lines
 *   GET  /chat/<key>/messages      the chat (?after=<line id>)
 *   POST /chat/<key>/messages      a message
 *   POST /chat/<key>/files         a file (multipart "file")
 *   POST /chat/<key>/profile       name and email (or the website's signed identity)
 *   POST /chat/<key>/identify      the website's signed identity → the person's chat, any browser
 *   POST /chat/<key>/seen          the visitor has it in front of them
 *   POST /chat/<key>/end           the visitor ends it (resolved)
 *   POST /chat/<key>/rate          the visitor's rating, 1-5, and a comment
 *   POST /chat/<key>/history       the visitor's chats: { tokens, identity? }
 *   GET  /chat/<key>/live          WebSocket (the ChatRoom)
 *   GET  /chat/files/…             a file, by its signed link
 */

const json = (data: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(data), {
		...init,
		headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
	});

function cors(origin: string | null): Record<string, string> {
	return origin
		? {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-allow-headers": "authorization, content-type",
				"access-control-max-age": "86400",
				vary: "Origin",
			}
		: { vary: "Origin" };
}

const fail = (
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
) => json({ error: { code, message } }, { status, headers });

function errorResponse(error: unknown, headers: Record<string, string>) {
	if (error instanceof ApiError)
		return fail(error.status, error.code, error.message, {
			...headers,
			...(error.headers ?? {}),
		});
	if (error instanceof z.ZodError) {
		const issue = error.issues[0];
		return fail(422, "validation_error", issue?.message ?? "Invalid", headers);
	}
	console.error("chat:", error);
	return fail(500, "internal_error", "Something went wrong; try again", headers);
}

const bearer = (req: Request) =>
	/^Bearer\s+(mrv_[A-Za-z0-9]+)\s*$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

async function readJson(req: Request) {
	if (Number(req.headers.get("content-length") ?? 0) > 64_000)
		throw new ApiError(413, "too_large", "Too large");
	const text = await req.text();
	if (text.length > 64_000) throw new ApiError(413, "too_large", "Too large");
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new ApiError(400, "invalid_json", "Not JSON");
	}
}

export async function handleChat(request: Request, now = Date.now()): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path.startsWith("/chat/files/")) {
		if (request.method !== "GET" && request.method !== "HEAD")
			return new Response("Method not allowed", { status: 405 });
		return serveChatFile(path, now);
	}
	const script = /^\/chat\/(mrc_[A-Za-z0-9]{24})\.js$/.exec(path);
	if (script?.[1]) return widgetScript(script[1], url);
	const m = /^\/chat\/(mrc_[A-Za-z0-9]{24})\/([a-z]+)$/.exec(path);
	if (!m?.[1] || !m[2]) return new Response("Not found", { status: 404 });
	const [, key, action] = m;
	if (action === "try" && request.method === "GET") return tryPage(key);
	const origin = request.headers.get("origin");
	const w = await widgetByKey(key, now);
	const allowed = w && originAllowed(w.widget, origin);
	const headers = allowed ? cors(origin) : { vary: "Origin" };
	if (request.method === "OPTIONS")
		return new Response(null, { status: allowed ? 204 : 403, headers });
	if (!w) return fail(404, "not_found", "This chat doesn't exist", headers);
	if (!allowed)
		return fail(
			403,
			"origin_not_allowed",
			"This website isn't allowed to use this chat",
			headers,
		);
	if (!w.widget.enabled) return fail(410, "chat_off", "This chat is turned off", headers);
	try {
		switch (`${request.method} ${action}`) {
			case "POST start": {
				const body = await readJson(request);
				const ip = request.headers.get("cf-connecting-ip");
				// A visitor the website signed in needs no robot check (and one that must be
				// signed in but isn't is refused here).
				const who = await identityOf(
					w.widget,
					typeof body.identity === "string" ? body.identity : null,
					now,
				);
				const { verifyTurnstile } = await import("./turnstile");
				const token = typeof body.turnstile === "string" ? body.turnstile : "";
				if (!who && !(await verifyTurnstile(w.inbox.organization_id, token, ip)))
					return fail(
						403,
						"turnstile_failed",
						"We couldn't check you're not a robot; try again",
						headers,
					);
				const started = await startChat(w, body, { ip, now });
				const lines = await chatLines(started.conversation.id);
				return json(
					{
						token: started.token,
						conversation: await chatState(started.conversation),
						messages: await linesFor("visitor", lines, now),
					},
					{ status: 201, headers },
				);
			}
			case "GET messages": {
				const chat = await need(key, request);
				const lines = await chatLines(chat.conversation.id, {
					after: url.searchParams.get("after"),
				});
				return json(
					{
						conversation: await chatState(chat.conversation),
						messages: await linesFor("visitor", lines, now),
					},
					{ headers },
				);
			}
			case "POST messages": {
				const chat = await need(key, request);
				const line = await visitorSays(chat, await readJson(request), now);
				return json(
					{ message: (await linesFor("visitor", [line], now))[0] },
					{ status: 201, headers },
				);
			}
			case "POST files": {
				const chat = await need(key, request);
				if (
					Number(request.headers.get("content-length") ?? 0) >
					CHAT_LIMITS.fileBytes + 100_000
				)
					return fail(413, "too_large", "Files up to 10 MB", headers);
				const form = await request.formData().catch(() => null);
				const file = form?.get("file");
				if (!file || typeof file === "string")
					return fail(422, "validation_error", "file: choose a file", headers);
				const line = await visitorSendsFile(
					chat,
					{
						filename: file.name,
						content_type: file.type,
						bytes: await file.arrayBuffer(),
					},
					{ client_id: (form?.get("client_id") as string | null) ?? null, now },
				);
				return json(
					{ message: (await linesFor("visitor", [line], now))[0] },
					{ status: 201, headers },
				);
			}
			case "POST profile": {
				const chat = await need(key, request);
				const fresh = await visitorProfile(chat, await readJson(request), now);
				return json({ conversation: await chatState(fresh) }, { headers });
			}
			case "POST identify": {
				// Bearer optional: the chat this browser has, if any.
				const current = bearer(request) ? await visitorChat(key, bearer(request)) : null;
				const r = await identifyVisitor(w, current, await readJson(request), {
					ip: request.headers.get("cf-connecting-ip"),
					now,
				});
				if (r.status === "none" || r.status === "other_person")
					return json({ status: r.status }, { headers });
				const lines = await chatLines(r.conversation.id);
				return json(
					{
						status: r.status,
						...(r.status === "resumed" ? { token: r.token } : {}),
						conversation: await chatState(r.conversation),
						messages: await linesFor("visitor", lines, now),
					},
					{ headers },
				);
			}
			case "POST seen": {
				const chat = await need(key, request);
				await markVisitorSeen(chat.conversation.id, now);
				return json({ ok: true }, { headers });
			}
			case "POST end": {
				const chat = await need(key, request);
				const fresh = await visitorEnds(chat, now);
				return json({ conversation: await chatState(fresh) }, { headers });
			}
			case "POST rate": {
				const chat = await need(key, request);
				const fresh = await visitorRates(chat, await readJson(request), now);
				return json({ conversation: await chatState(fresh) }, { headers });
			}
			case "POST history": {
				const conversations = await visitorHistory(w, await readJson(request), now);
				return json({ conversations }, { headers });
			}
			case "GET live": {
				if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
					return fail(426, "upgrade_required", "Expected a WebSocket", headers);
				const chat = await visitorChat(key, url.searchParams.get("token"));
				if (!chat) return fail(401, "unknown_chat", "This chat has ended", headers);
				const room = chatRoom(chat.conversation.id);
				if (!room)
					return fail(503, "unavailable", "Live updates aren't available", headers);
				const forwarded = new Request(request.url, {
					headers: {
						upgrade: "websocket",
						"x-chat-role": "visitor",
						// Encoded: a header carries ASCII only («López»).
						"x-chat-name": encodeURIComponent(chat.conversation.visitor_name ?? ""),
						"x-chat-conversation": chat.conversation.id,
					},
				});
				return room.fetch(forwarded);
			}
			default:
				return fail(404, "not_found", "Not found", headers);
		}
	} catch (error) {
		return errorResponse(error, headers);
	}
}

/**
 * GET /chat-live/<conversation>: the dashboard's WebSocket on a chat, for a signed-in member of
 * the organization whose brands include it. Carries the visitor's messages, "typing…", "seen"
 * and presence; the team's own messages still go through the server functions.
 */
export async function handleTeamLive(request: Request): Promise<Response> {
	const id = /^\/chat-live\/([0-9a-f-]{36})$/.exec(new URL(request.url).pathname)?.[1];
	if (!id) return new Response("Not found", { status: 404 });
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response("Expected a WebSocket", { status: 426 });
	// Only the dashboard's own pages (a cookie alone isn't enough across sites).
	const origin = request.headers.get("origin");
	if (!origin || origin !== new URL(baseUrl()).origin)
		return new Response("Forbidden", { status: 403 });
	const { auth } = await import("./auth");
	const session = await auth().api.getSession({ headers: request.headers });
	if (!session) return new Response("Sign in again", { status: 401 });
	const m = schema.member;
	const active = session.session.activeOrganizationId ?? null;
	const rows = await db
		.select({ organizationId: m.organizationId })
		.from(m)
		.where(eq(m.userId, session.user.id));
	const org = rows.find((r) => r.organizationId === active) ?? rows[0];
	if (!org) return new Response("Forbidden", { status: 403 });
	const { brandIds } = await import("./brands");
	const brands = await brandIds(org.organizationId);
	const x = await db
		.select({
			id: schema.conversations.id,
			brand: schema.conversations.organization_id,
			channel: schema.conversations.channel,
		})
		.from(schema.conversations)
		.where(eq(schema.conversations.id, id))
		.get();
	if (!x || !brands.includes(x.brand) || x.channel !== "chat")
		return new Response("Not found", { status: 404 });
	const room = chatRoom(id);
	if (!room) return new Response("Live updates aren't available", { status: 503 });
	// A member without emails:unmasked sees the visitor's digits dotted here too.
	const { memberAccess } = await import("./access");
	const access = await memberAccess(org.organizationId, session.user.id);
	return room.fetch(
		new Request(request.url, {
			headers: {
				upgrade: "websocket",
				"x-chat-role": "team",
				"x-chat-masked": access.can("emails:unmasked") ? "0" : "1",
				// The visitor sees "Ana is typing"; never an email address.
				"x-chat-name": encodeURIComponent(
					/@/.test(session.user.name ?? "")
						? ""
						: ((session.user.name ?? "").trim().split(/\s+/)[0] ?? ""),
				),
				"x-chat-conversation": id,
			},
		}),
	);
}

async function need(key: string, request: Request): Promise<VisitorChat> {
	const chat = await visitorChat(key, bearer(request));
	if (!chat) throw new ApiError(401, "unknown_chat", "This chat has ended; start a new one");
	return chat;
}

/** The widget's code with its settings in front, for one public key. */
async function widgetScript(key: string, url: URL) {
	const w = await widgetByKey(key);
	const preview = url.searchParams.get("preview") === "1";
	// The dashboard's preview works while the chat is still off.
	if (!w || (!w.widget.enabled && !preview))
		return new Response(
			`/* Mailroom chat: ${w ? "this chat is turned off" : "no chat with this key"} */`,
			{
				status: w ? 200 : 404,
				headers: {
					"content-type": "text/javascript; charset=utf-8",
					"cache-control": "public, max-age=60",
					"access-control-allow-origin": "*",
				},
			},
		);
	const config = await publicConfig(w);
	const settings = JSON.stringify({ ...config, preview }).replace(/</g, "\\u003c");
	const body = `/* Mailroom chat · ${baseUrl()} */\n(function(){\n${widgetSource}\nmailroomChat(${settings});\n})();\n`;
	return new Response(body, {
		headers: {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": preview ? "no-store" : "public, max-age=300",
			"access-control-allow-origin": "*",
			"x-content-type-options": "nosniff",
		},
	});
}

/** What the widget needs to draw itself (nothing secret). */
export async function publicConfig(w: NonNullable<Awaited<ReturnType<typeof widgetByKey>>>) {
	const d = designOf(w.widget);
	const brand = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, w.inbox.organization_id))
		.get();
	// The brand's logo: in the header (show_logo) and on the launcher (launcher_icon "logo").
	let brandLogo: string | null = null;
	if (d.show_logo || d.launcher_icon === "logo") {
		const { orgLogos } = await import("./org-logos");
		const l = (await orgLogos([w.inbox.organization_id])).get(w.inbox.organization_id);
		if (l) brandLogo = l.url.startsWith("http") ? l.url : `${baseUrl()}${l.url}`;
	}
	const logo = d.show_logo ? brandLogo : null;
	const { brandWidget } = await import("./turnstile");
	const turnstile = await brandWidget(w.inbox.organization_id);
	const days = w.inbox.retention_days ?? inboundRetentionDays();
	return {
		key: w.widget.public_key,
		api: `${baseUrl()}/chat/${w.widget.public_key}`,
		title: d.title || brand?.name || w.inbox.name,
		subtitle: d.subtitle,
		greeting: d.greeting,
		placeholder: d.placeholder,
		color: d.color,
		position: d.position,
		theme: d.theme,
		launcher: d.launcher,
		launcher_text: d.launcher_text,
		logo,
		brand_logo: brandLogo,
		away: d.away,
		ask_email: w.widget.ask_email,
		ask_name: d.ask_name,
		offset_x: d.offset_x,
		offset_y: d.offset_y,
		corners: d.corners,
		header: d.header,
		color2: d.color2,
		background: d.background,
		bubbles: d.bubbles,
		team_bubbles: d.team_bubbles,
		font: d.font,
		text_size: d.text_size,
		width: d.width,
		shadow: d.shadow,
		launcher_size: d.launcher_size,
		launcher_icon: d.launcher_icon,
		hide_mobile: d.hide_mobile,
		nudge_after: d.nudge_after,
		z_index: d.z_index,
		custom_css: d.custom_css,
		language: d.language,
		ask_rating: d.ask_rating,
		allow_end: d.allow_end,
		identity_required: w.widget.identity_required,
		retention: d.show_retention && days > 0 ? days : null,
		turnstile: turnstile?.sitekey ?? null,
		address: w.inbox.address.includes("+") ? null : w.inbox.address,
		// What the visitor may send (checked again here: this only shapes the widget).
		files: w.widget.files_enabled
			? {
					accept: acceptFor(fileKindsOf(w.widget)),
					max_mb: w.widget.file_max_mb,
					kinds: fileKindsOf(w.widget),
				}
			: null,
	};
}

/** A page with nothing but the widget, open: to try it before putting it on a site. */
async function tryPage(key: string) {
	const w = await widgetByKey(key);
	if (!w) return new Response("Not found", { status: 404 });
	const brand = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, w.inbox.organization_id))
		.get();
	const name = (brand?.name ?? w.inbox.name).replace(/[<>&"]/g, "");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Try the chat · ${name}</title><meta name="robots" content="noindex">
<style>:root{color-scheme:light dark}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:Canvas;color:CanvasText;min-height:100vh;display:grid;place-items:center}main{max-width:560px;padding:32px 20px}h1{font-size:28px;margin:0 0 8px;letter-spacing:-.01em}p{opacity:.7;margin:0 0 6px}code{font-size:13px;padding:2px 6px;border-radius:6px;background:color-mix(in srgb,CanvasText 8%,transparent)}</style></head>
<body><main><h1>${name}</h1><p>This page only has the chat on it, to try it: write as a visitor would, and answer from Mailroom or your email.</p><p>Messages sent here are real.</p></main>
<script src="${baseUrl()}/chat/${w.widget.public_key}.js" async></script></body></html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"x-frame-options": "SAMEORIGIN",
			},
		},
	);
}
