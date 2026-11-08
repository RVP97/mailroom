import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type ChatWidget, designOf, identityOf } from "./chat";
import { db, schema } from "./db";
import { ApiError } from "./errors";
import type { Inbox } from "./inboxes";

/**
 * The website chat as a marketing channel: the chat's newsletter (its sign-up and latest issue),
 * messages for one segment, and a signed-in visitor's subscription.
 *
 * Who someone is, and what they're subscribed to, is only told to a visitor the website signed
 * in (a verified identity): an email typed into the chat could be anyone's.
 */

type Widget = { widget: ChatWidget; inbox: Inbox };

async function newsletterOf(w: Widget) {
	const id = designOf(w.widget).newsletter_id;
	if (!id) return null;
	return (
		(await db
			.select()
			.from(schema.newsletters)
			.where(
				and(
					eq(schema.newsletters.id, id),
					eq(schema.newsletters.organization_id, w.inbox.organization_id),
				),
			)
			.get()) ?? null
	);
}

/** What the widget shows of the newsletter (nothing about who's on it). */
export async function chatNewsletter(w: Widget) {
	const n = await newsletterOf(w);
	if (!n) return null;
	const { latestIssue, newsletterUrl } = await import("./newsletters");
	const form = n.form_id
		? await db
				.select({ enabled: schema.signupForms.enabled })
				.from(schema.signupForms)
				.where(eq(schema.signupForms.id, n.form_id))
				.get()
		: null;
	return {
		name: n.name,
		description: n.description,
		latest: await latestIssue(n),
		archive: n.public ? newsletterUrl(n.slug) : null,
		// Anyone may ask for it by email (double opt-in) when it has a sign-up form that's on.
		signup: !!form?.enabled,
	};
}

/** The verified visitor's contact in the chat's brand, if they're one. */
async function contactFor(w: Widget, identity: unknown, now: number) {
	if (typeof identity !== "string" || !identity) return null;
	const who = await identityOf(w.widget, identity, now).catch(() => null);
	if (!who?.email) return null;
	const email = who.email.trim().toLowerCase();
	const contact =
		(await db
			.select()
			.from(schema.contacts)
			.where(
				and(
					eq(schema.contacts.organization_id, w.inbox.organization_id),
					eq(schema.contacts.email, email),
				),
			)
			.get()) ?? null;
	return { email, contact };
}

async function subscribed(w: Widget, contact: typeof schema.contacts.$inferSelect | null) {
	const n = designOf(w.widget).newsletter_id;
	if (!n || !contact || contact.unsubscribed) return false;
	const { newslettersOf } = await import("./timeline");
	return (await newslettersOf(w.inbox.organization_id, contact.id)).some((x) => x.id === n);
}

/**
 * POST /chat/<key>/audience { identity }: which of the chat's segment messages are for this
 * visitor (by their place in the list), and whether they get the newsletter. Without a verified
 * identity: none, and nothing.
 */
export async function visitorAudience(w: Widget, body: { identity?: unknown }, now = Date.now()) {
	const me = await contactFor(w, body.identity, now);
	if (!me) return { known: false, popups: [] as number[], newsletter: null };
	const d = designOf(w.widget);
	const wanted = (d.popups ?? [])
		.map((p, i) => ({ i, seg: p.segment_id }))
		.filter((p): p is { i: number; seg: string } => !!p.seg);
	let popups: number[] = [];
	if (me.contact && wanted.length) {
		const rows = await db
			.select({ id: schema.contactSegments.segment_id })
			.from(schema.contactSegments)
			.where(
				and(
					eq(schema.contactSegments.contact_id, me.contact.id),
					inArray(schema.contactSegments.segment_id, [
						...new Set(wanted.map((p) => p.seg)),
					]),
				),
			);
		const mine = new Set(rows.map((r) => r.id));
		popups = wanted.filter((p) => mine.has(p.seg)).map((p) => p.i);
	}
	return {
		known: true,
		popups,
		newsletter: d.newsletter_id
			? { subscribed: await subscribed(w, me.contact), email: me.email }
			: null,
	};
}

const subscribeInput = z.object({
	action: z.enum(["subscribe", "unsubscribe"]).default("subscribe"),
	identity: z.string().max(4000).nullish(),
	email: z.string().trim().max(254).nullish(),
	name: z.string().trim().max(100).nullish(),
	turnstile: z.string().max(4000).nullish(),
});

/**
 * POST /chat/<key>/subscribe: the chat's newsletter. A visitor the website signed in is
 * subscribed (or unsubscribed) at once: it's them, and the website vouches for it. Anyone else
 * gets the newsletter's sign-up form's confirmation email (double opt-in, robot check).
 */
export async function chatSubscribe(
	w: Widget,
	raw: unknown,
	from: { ip: string | null; origin: string | null },
	now = Date.now(),
) {
	const v = subscribeInput.parse(raw ?? {});
	const n = await newsletterOf(w);
	if (!n) throw new ApiError(404, "no_newsletter", "This chat has no newsletter");
	const brand = w.inbox.organization_id;
	if (v.identity) {
		const me = await contactFor(w, v.identity, now);
		if (!me) throw new ApiError(401, "invalid_identity", "We couldn't confirm who you are");
		const { actForPerson } = await import("./automations");
		const { contact_id } = await actForPerson(
			brand,
			me.email,
			{ type: "newsletter", newsletter_id: n.id, action: v.action },
			now,
		);
		const { updateContact, getContact } = await import("./contacts");
		// They asked for it themselves, signed in: an earlier "unsubscribe from everything" ends.
		if (v.action === "subscribe" && me.contact?.unsubscribed)
			await updateContact(brand, contact_id, { unsubscribed: false }, now);
		const fresh = await getContact(brand, contact_id);
		return {
			status: v.action === "subscribe" ? "subscribed" : "unsubscribed",
			subscribed: await subscribed(w, fresh),
			email: me.email,
		};
	}
	if (v.action === "unsubscribe")
		throw new ApiError(401, "identity_required", "Sign in to change your subscription");
	if (!n.form_id)
		throw new ApiError(
			409,
			"signup_closed",
			"Sign-ups aren't open here; try the newsletter's page",
		);
	const { signUpWith } = await import("./signup-forms");
	const r = await signUpWith(
		n.form_id,
		{ email: v.email ?? "", name: v.name, turnstile: v.turnstile, source: "chat" },
		from,
		now,
	);
	if (!r.ok) throw new ApiError(r.status >= 400 ? r.status : 400, "signup_failed", r.message);
	return { status: "check_inbox", subscribed: false, email: null, message: r.message };
}
