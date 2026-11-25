/**
 * Official zero-dependency TypeScript SDK for Mailroom.
 * Works in Node 18+, Bun, Deno, Cloudflare Workers, and browsers.
 *
 *   import { Mailroom } from "./sdk";
 *   const mr = new Mailroom({ url: "https://mail.yourapp.com", apiKey: process.env.MAILROOM_API_KEY! });
 *   await mr.emails.send({ from: "hi@yourapp.com", to: "ana@acme.com", subject: "Welcome", html: "<p>Hi!</p>" });
 */

export interface MailroomOptions {
	/** Base URL of your Mailroom deployment, e.g. https://mail.yourapp.com */
	url: string;
	/** Organization API key (mr_…) */
	apiKey: string;
	/** Optional default brand slug or id */
	brand?: string;
	/** Optional custom fetch implementation */
	fetch?: typeof globalThis.fetch;
}

export interface SendEmailInput {
	from: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	reply_to?: string | string[];
	subject?: string;
	html?: string;
	text?: string;
	scheduled_at?: string;
	unsubscribe_group?: string;
	template?: { id: string; variables?: Record<string, string | number> };
	tags?: { name: string; value: string }[];
	idempotencyKey?: string;
}

export interface UpsertContactInput {
	email: string;
	first_name?: string;
	last_name?: string;
	unsubscribed?: boolean;
	properties?: Record<string, string | number>;
	segments?: string[];
	topics?: { id: string; subscription: "opt_in" | "opt_out" }[];
}

export interface UpsertCompanyInput {
	name: string;
	domain?: string | null;
	plan?: string | null;
	mrr?: number | null;
	seats?: number | null;
	renewal_at?: string | null;
	website?: string | null;
	notes?: string | null;
	properties?: Record<string, string | number>;
}

export class MailroomError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "MailroomError";
		this.status = status;
		this.code = code;
	}
}

export class Mailroom {
	private baseUrl: string;
	private apiKey: string;
	private brand?: string;
	private fetcher: typeof globalThis.fetch;

	constructor(options: MailroomOptions) {
		this.baseUrl = options.url.replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.brand = options.brand;
		this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	async request<T = unknown>(
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		opts: {
			body?: unknown;
			query?: Record<string, string | number | boolean | undefined>;
			headers?: Record<string, string>;
		} = {},
	): Promise<T> {
		const url = new URL(`${this.baseUrl}/api${path.startsWith("/") ? path : `/${path}`}`);
		const query = { ...(this.brand ? { brand: this.brand } : {}), ...opts.query };
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
		}
		const res = await this.fetcher(url.toString(), {
			method,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
				...opts.headers,
			},
			...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
		});
		const text = await res.text();
		let data: Record<string, unknown> | null = null;
		try {
			data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
		} catch {
			data = { message: text };
		}
		if (!res.ok) {
			throw new MailroomError(
				res.status,
				String(data?.name ?? "api_error"),
				String(data?.message ?? res.statusText),
			);
		}
		return data as T;
	}

	readonly emails = {
		send: (input: SendEmailInput) => {
			const { idempotencyKey, ...body } = input;
			return this.request<{ id: string }>("POST", "/emails", {
				body,
				headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
			});
		},
		batch: (emails: SendEmailInput[]) =>
			this.request<{ data: { id: string }[] }>("POST", "/emails/batch", { body: emails }),
		list: (query?: { status?: string; search?: string; limit?: number; after?: string }) =>
			this.request<{ data: unknown[]; has_more: boolean }>("GET", "/emails", { query }),
		get: (id: string) =>
			this.request<Record<string, unknown>>("GET", `/emails/${encodeURIComponent(id)}`),
		check: (input: { subject: string; html?: string; text?: string; marketing?: boolean }) =>
			this.request<{ findings: unknown[] }>("POST", "/emails/check", { body: input }),
	};

	readonly templates = {
		list: () => this.request<{ data: unknown[] }>("GET", "/templates"),
		get: (idOrAlias: string) =>
			this.request<Record<string, unknown>>(
				"GET",
				`/templates/${encodeURIComponent(idOrAlias)}`,
			),
		create: (body: Record<string, unknown>) =>
			this.request<{ id: string }>("POST", "/templates", { body }),
		update: (id: string, body: Record<string, unknown>) =>
			this.request<Record<string, unknown>>("PATCH", `/templates/${encodeURIComponent(id)}`, {
				body,
			}),
		publish: (id: string) =>
			this.request<Record<string, unknown>>(
				"POST",
				`/templates/${encodeURIComponent(id)}/publish`,
			),
	};

	readonly contacts = {
		list: (query?: { search?: string; segment_id?: string; limit?: number; after?: string }) =>
			this.request<{ data: unknown[]; has_more: boolean }>("GET", "/contacts", { query }),
		upsert: (body: UpsertContactInput) =>
			this.request<Record<string, unknown>>("POST", "/contacts", { body }),
		get: (idOrEmail: string) =>
			this.request<Record<string, unknown>>(
				"GET",
				`/contacts/${encodeURIComponent(idOrEmail)}`,
			),
		delete: (idOrEmail: string) =>
			this.request<Record<string, unknown>>(
				"DELETE",
				`/contacts/${encodeURIComponent(idOrEmail)}`,
			),
	};

	readonly companies = {
		list: (query?: { search?: string; plan?: string; limit?: number }) =>
			this.request<{ data: unknown[] }>("GET", "/companies", { query }),
		upsert: (body: UpsertCompanyInput) =>
			this.request<Record<string, unknown>>("POST", "/companies", { body }),
		get: (id: string) =>
			this.request<Record<string, unknown>>("GET", `/companies/${encodeURIComponent(id)}`),
		delete: (id: string) =>
			this.request<Record<string, unknown>>("DELETE", `/companies/${encodeURIComponent(id)}`),
	};

	readonly events = {
		track: (input: {
			event: string;
			email?: string;
			contact_id?: string;
			data?: Record<string, unknown>;
		}) => this.request<Record<string, unknown>>("POST", "/events", { body: input }),
	};

	readonly broadcasts = {
		list: () => this.request<{ data: unknown[] }>("GET", "/broadcasts"),
		create: (body: Record<string, unknown>) =>
			this.request<Record<string, unknown>>("POST", "/broadcasts", { body }),
		send: (id: string, body?: Record<string, unknown>) =>
			this.request<Record<string, unknown>>(
				"POST",
				`/broadcasts/${encodeURIComponent(id)}/send`,
				{ body },
			),
	};

	readonly inbox = {
		listConversations: (query?: { status?: string; search?: string; limit?: number }) =>
			this.request<{ data: unknown[] }>("GET", "/inboxes/conversations", { query }),
		getConversation: (id: string) =>
			this.request<Record<string, unknown>>(
				"GET",
				`/inboxes/conversations/${encodeURIComponent(id)}`,
			),
	};

	readonly status = {
		get: () => this.request<Record<string, unknown>>("GET", "/status"),
		stats: (days = 30) =>
			this.request<Record<string, unknown>>("GET", "/stats", { query: { days } }),
	};
}
