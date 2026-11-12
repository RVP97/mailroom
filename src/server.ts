import { instrumentDurableObjectWithSentry, withSentry } from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import { ChatRoom as ChatRoomObject } from "./server/chat-room";
import { Dispatcher as DispatcherObject } from "./server/dispatcher";
import { sentryOptions } from "./server/sentry";

export const Dispatcher = instrumentDurableObjectWithSentry(
	(env: Env) => sentryOptions(env) ?? {},
	DispatcherObject,
);

export const ChatRoom = instrumentDurableObjectWithSentry(
	(env: Env) => sentryOptions(env) ?? {},
	ChatRoomObject,
);

const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"X-Frame-Options": "DENY",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function secured(res: Response) {
	if (res.status === 101) return res;
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries(SECURITY_HEADERS))
		if (!out.headers.has(k)) out.headers.set(k, v);
	return out;
}

/**
 * The pages a reader of an email can land on, on Mailroom's address and on each domain's own
 * host (src/server/public-host.ts); null for any other path.
 */
async function publicPage(request: Request, url: URL): Promise<Response | null> {
	// Each domain's brand logo, which inboxes fetch from its BIMI record.
	const bimi = /^\/bimi\/([a-z0-9.-]+)\.svg$/.exec(url.pathname);
	if (bimi?.[1] && (request.method === "GET" || request.method === "HEAD")) {
		const { bimiLogo } = await import("./server/provision");
		const svg = await bimiLogo(bimi[1]);
		if (!svg) return secured(new Response("Not found", { status: 404 }));
		return secured(
			new Response(request.method === "HEAD" ? null : svg, {
				headers: {
					"content-type": "image/svg+xml",
					"cache-control": "public, max-age=3600",
					"access-control-allow-origin": "*",
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
				},
			}),
		);
	}
	// The same logos as PNG, for emails (mail apps don't show SVG): drawn once, then cached.
	const png = /^\/(bimi|logos)\/([A-Za-z0-9_.-]{1,100})\.png$/.exec(url.pathname);
	if (png?.[1] && png[2] && (request.method === "GET" || request.method === "HEAD")) {
		const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
		const key = new Request(url.toString());
		const hit = await cache?.match(key).catch(() => undefined);
		if (hit) return request.method === "HEAD" ? new Response(null, hit) : hit;
		const { logoPng } = await import("./server/org-logos");
		const image = await logoPng(png[1] as "bimi" | "logos", png[2]);
		if (!image) return secured(new Response("Not found", { status: 404 }));
		const res = secured(
			new Response(image, {
				headers: {
					"content-type": "image/png",
					"cache-control": url.searchParams.has("v")
						? "public, max-age=31536000, immutable"
						: "public, max-age=3600",
					"access-control-allow-origin": "*",
					"content-security-policy": "default-src 'none'",
				},
			}),
		);
		await cache?.put(key, res.clone()).catch(() => {});
		return request.method === "HEAD" ? new Response(null, res) : res;
	}
	// Each organization's own logo (the switcher's), uploaded in Settings.
	const logo = /^\/logos\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
	if (logo?.[1] && (request.method === "GET" || request.method === "HEAD")) {
		const { orgLogoImage } = await import("./server/org-logos");
		const image = await orgLogoImage(logo[1]);
		if (!image) return secured(new Response("Not found", { status: 404 }));
		return secured(
			new Response(request.method === "HEAD" ? null : image.bytes, {
				headers: {
					"content-type": image.type,
					// Its URL changes with each new logo (?v=), so it can be kept long.
					"cache-control": url.searchParams.has("v")
						? "private, max-age=31536000, immutable"
						: "private, max-age=60",
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
				},
			}),
		);
	}
	// The rating survey sent after a conversation is resolved (src/server/inbox-workflow.ts).
	if (
		url.pathname.startsWith("/rate/") &&
		(request.method === "GET" || request.method === "POST")
	) {
		const { handleRate } = await import("./server/inbox-workflow");
		return secured(await handleRate(request));
	}
	// Images in emails, uploaded in the email editor (src/server/media.ts).
	if (
		url.pathname.startsWith("/media/") &&
		(request.method === "GET" || request.method === "HEAD")
	) {
		const { serveMedia } = await import("./server/media");
		return secured(await serveMedia(url.pathname, request.method === "HEAD"));
	}
	// Public sign-up forms: a website's newsletter box, and the confirmation link.
	if (url.pathname.startsWith("/subscribe/")) {
		const { handleSubscribe } = await import("./server/signup-forms");
		return secured(await handleSubscribe(request));
	}
	// Newsletters' public archives and every broadcast's web version (src/server/newsletters.ts).
	if (url.pathname.startsWith("/n/") || url.pathname.startsWith("/view/")) {
		const { handleNewsletterPage } = await import("./server/newsletters");
		return secured(await handleNewsletterPage(request));
	}
	// Each brand's help center (src/server/help-center.ts).
	if (url.pathname.startsWith("/help/")) {
		const { handleHelpPage } = await import("./server/help-center");
		return secured(await handleHelpPage(request));
	}
	// Surveys: a website's link, an email's answer links (src/server/surveys.ts).
	if (url.pathname.startsWith("/s/") && (request.method === "GET" || request.method === "POST")) {
		const { handleSurveyPage } = await import("./server/surveys");
		return secured(await handleSurveyPage(request));
	}
	// A subscriber's referral link (src/server/referrals.ts).
	const referral = /^\/r\/([A-Za-z0-9]{1,32})$/.exec(url.pathname);
	if (referral?.[1] && request.method === "GET") {
		const { handleReferral } = await import("./server/referrals");
		return secured(await handleReferral(referral[1]));
	}
	// A subscriber's own referral page: their count and rewards (signed, for them only).
	const mine = /^\/r\/([A-Za-z0-9]{1,32})\/me\/([A-Za-z0-9_-]{10,40})$/.exec(url.pathname);
	if (mine?.[1] && mine[2] && request.method === "GET") {
		const { handleReferralPage } = await import("./server/referrals");
		return secured(await handleReferralPage(mine[1], mine[2]));
	}
	// An answer to a poll in a broadcast (src/server/polls.ts).
	if (url.pathname.startsWith("/poll/") && request.method === "GET") {
		const { handlePoll } = await import("./server/polls");
		return secured(await handlePoll(request));
	}
	// One-click unsubscribe from an email sent with an unsubscribe group.
	if (url.pathname === "/unsubscribe") {
		const { handleUnsubscribePage } = await import("./server/unsubscribes");
		return secured(await handleUnsubscribePage(request));
	}
	return null;
}

// Sentry (src/server/sentry.ts) sees what each handler throws.
export default withSentry(sentryOptions, {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		// Opens and clicks (src/server/tracking.ts), here and on each domain's links.<domain>.
		if (/^\/[co]\//.test(url.pathname)) {
			const { handleTracking } = await import("./server/tracking");
			return secured(await handleTracking(request, ctx));
		}
		// A domain's own host (any other hostname routed here: links.<domain>, track.<domain>…)
		// serves its readers' pages and nothing else, never the dashboard on someone's domain.
		if (
			url.hostname !== new URL(env.BETTER_AUTH_URL).hostname &&
			!url.hostname.endsWith(".workers.dev") &&
			url.hostname !== "localhost"
		) {
			const { PUBLIC_PATH, inPublicScope, scopeForHost } = await import(
				"./server/public-host"
			);
			const own =
				url.pathname === "/" || PUBLIC_PATH.test(url.pathname)
					? await scopeForHost(url.hostname)
					: null;
			if (!own) return new Response("Not found", { status: 404 });
			if (url.pathname === "/") {
				const { hostHome } = await import("./server/newsletters");
				return secured(await inPublicScope(own, () => hostHome(own)));
			}
			const page = await inPublicScope(own, () => publicPage(request, url));
			return page ?? new Response("Not found", { status: 404 });
		}
		// The MCP server and its OAuth endpoints (the consent page is an app route).
		const { isOAuthPath, REGISTER_PATH } = await import("./server/mcp/paths");
		if (isOAuthPath(url.pathname)) {
			if (url.pathname === REGISTER_PATH) {
				// Anyone may register a client (each is stored): limited per address.
				const { limitIp } = await import("./server/rate-limit");
				try {
					await limitIp(request);
				} catch {
					return new Response("Too many requests", { status: 429 });
				}
			}
			const { handleOAuth } = await import("./server/mcp/oauth");
			return secured(await handleOAuth(request, env, ctx));
		}
		// The public API (Resend-compatible), outside TanStack: no cookies, its own errors.
		if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/")) {
			const { handleApi } = await import("./server/api");
			return secured(await handleApi(request));
		}
		// Website chat: the widget's script and endpoints (CORS, by its websites), and the
		// dashboard's live connection to a chat (src/server/chat-public.ts).
		if (url.pathname.startsWith("/chat/")) {
			const { handleChat } = await import("./server/chat-public");
			return secured(await handleChat(request));
		}
		if (url.pathname.startsWith("/chat-live/")) {
			const { handleTeamLive } = await import("./server/chat-public");
			return secured(await handleTeamLive(request));
		}
		const page = await publicPage(request, url);
		if (page) return page;
		// A received email's attachment, from the signed link the API gives (src/server/inbound.ts).
		if (
			/^\/inbound\/[^/]+\/[^/]+\/\d+\/[^/]+$/.test(url.pathname) &&
			request.method === "GET"
		) {
			const { serveAttachment } = await import("./server/inbound");
			return secured(await serveAttachment(url.pathname));
		}
		// A file of the long-term archive, from the dashboard's signed link (src/server/archive.ts).
		if (url.pathname.startsWith("/archive-file/") && request.method === "GET") {
			const { serveArchiveLink } = await import("./server/archive");
			return secured(await serveArchiveLink(url.pathname));
		}
		// Google's answer after an admin connects Gmail Postmaster Tools.
		if (url.pathname === "/postmaster/callback" && request.method === "GET") {
			const { handleCallback } = await import("./server/postmaster");
			return secured(await handleCallback(request));
		}
		// SES's events, posted by SNS.
		if (url.pathname === "/webhooks/ses") {
			if (request.method !== "POST")
				return new Response("Method not allowed", { status: 405 });
			const { handleSns } = await import("./server/events");
			let message: unknown;
			try {
				message = JSON.parse(await request.text());
			} catch {
				return new Response("Bad request", { status: 400 });
			}
			const result = await handleSns(message as never);
			const status = result === "invalid" ? 403 : result === "retry" ? 503 : 200;
			return new Response(result, { status });
		}
		return secured(await handler.fetch(request));
	},
	// DMARC aggregate reports, routed here by Cloudflare Email Routing (server/dmarc-reports.ts).
	async email(message: ForwardableEmailMessage, _env: Env, _ctx: ExecutionContext) {
		const { dmarcReportsAddress, receiveDmarcEmail } = await import("./server/dmarc-reports");
		if (message.to.toLowerCase() !== dmarcReportsAddress()) {
			message.setReject("No such mailbox");
			return;
		}
		await receiveDmarcEmail(message);
	},
	async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
		const { runCron } = await import("./server/cron");
		ctx.waitUntil(runCron(controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>);
