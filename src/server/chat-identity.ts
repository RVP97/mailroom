import { z } from "zod";
import { ApiError } from "./errors";

/**
 * Identity verification for the website chat: a website whose visitors sign in (an app's
 * dashboard) tells the widget who they are with a token it signs on its server, so the team
 * knows the person is who they say, and their chats follow them to any browser.
 *
 * The token is a JWT signed with HS256 and the widget's identity secret (mrcs_…, made in the
 * chat's settings, shown once):
 *
 *   { "sub": "<the person's id in your app>", "email": "…", "name": "…",
 *     "attributes": { "plan": "Pro", "company": "Acme" }, "exp": <unix seconds> }
 *
 * The widget passes it as MailroomChat.identify({ token }) or window.MailroomChatSettings =
 * { identity: token } before the script loads. Only `sub` and `exp` are required.
 */

export const IDENTITY_LIMITS = {
	/** How far ahead a token's expiry may be. */
	maxLifetimeSeconds: 30 * 86_400,
	attributes: 30,
	attributeKey: 40,
	attributeValue: 300,
};

export interface VerifiedIdentity {
	userId: string;
	email: string | null;
	name: string | null;
	attributes: Record<string, string | number | boolean>;
	exp: number;
}

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newIdentitySecret = () =>
	`mrcs_${[...crypto.getRandomValues(new Uint8Array(40))].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;

const payloadSchema = z.object({
	sub: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
	email: z.string().trim().max(320).nullish(),
	name: z.string().trim().max(100).nullish(),
	attributes: z.record(z.string(), z.unknown()).nullish(),
	exp: z.number(),
});

function b64urlBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const invalid = (message: string) => new ApiError(401, "invalid_identity", message);

/** Cleans the site's attributes: short keys, short plain values; the rest is dropped. */
function cleanAttributes(raw: Record<string, unknown> | null | undefined) {
	const out: Record<string, string | number | boolean> = {};
	if (!raw) return out;
	for (const [k, v] of Object.entries(raw)) {
		if (Object.keys(out).length >= IDENTITY_LIMITS.attributes) break;
		const key = k.trim().slice(0, IDENTITY_LIMITS.attributeKey);
		if (!key || key === "__proto__") continue;
		if (typeof v === "string") {
			const t = v.trim();
			if (t) out[key] = t.slice(0, IDENTITY_LIMITS.attributeValue);
		} else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))
			out[key] = v;
	}
	return out;
}

/** The person a token says the visitor is, when the widget's secret signed it and it's current. */
export async function verifyIdentity(
	secret: string | null | undefined,
	token: unknown,
	now = Date.now(),
): Promise<VerifiedIdentity> {
	if (!secret) throw invalid("This chat doesn't verify identities");
	if (typeof token !== "string" || token.length > 8000) throw invalid("Not an identity token");
	const parts = token.split(".");
	if (parts.length !== 3) throw invalid("Not an identity token");
	const [h, p, sig] = parts as [string, string, string];
	let header: { alg?: string };
	let payload: unknown;
	let signature: Uint8Array;
	try {
		header = JSON.parse(new TextDecoder().decode(b64urlBytes(h)));
		payload = JSON.parse(new TextDecoder().decode(b64urlBytes(p)));
		signature = b64urlBytes(sig);
	} catch {
		throw invalid("Not an identity token");
	}
	if (header.alg !== "HS256") throw invalid("Identity tokens are signed with HS256");
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const ok = await crypto.subtle.verify(
		"HMAC",
		key,
		signature as BufferSource,
		new TextEncoder().encode(`${h}.${p}`),
	);
	if (!ok) throw invalid("The identity token's signature doesn't match");
	const v = payloadSchema.safeParse(payload);
	if (!v.success) throw invalid("The identity token needs sub and exp");
	const seconds = now / 1000;
	if (v.data.exp <= seconds) throw invalid("The identity token has expired");
	if (v.data.exp > seconds + IDENTITY_LIMITS.maxLifetimeSeconds + 60)
		throw invalid("The identity token's exp is too far ahead (30 days at most)");
	const userId = v.data.sub;
	if (!userId || userId.length > 200)
		throw invalid("The identity token's sub is empty or too long");
	const email = v.data.email?.toLowerCase() || null;
	return {
		userId,
		email: email && /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email) ? email : null,
		name: v.data.name || null,
		attributes: cleanAttributes(v.data.attributes as Record<string, unknown> | null),
		exp: v.data.exp,
	};
}
