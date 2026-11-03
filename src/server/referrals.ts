import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Contact } from "./contacts";
import { db, schema } from "./db";
import type { ReferralReward } from "./db/schema";
import { publicUrl } from "./public-host";
import { iso } from "./time";

/**
 * A newsletter's referral program, for its brand's own subscribers. Each contact gets a share link
 * (/r/<code>, {{{REFERRAL_URL}}} in an email) that opens the newsletter's sign-up form. A friend
 * counts once they confirm the double opt-in email (so after Turnstile, a real inbox and a click),
 * and only a new contact counts: never someone already on the list, nor the referrer themself.
 * Reaching a milestone emails its reward (a published template) and starts automations waiting
 * for the "referral.milestone" event, with { count, reward } as its data.
 */

const ct = schema.contacts;
const nl = schema.newsletters;

/** No 0/O or 1/l/I, so a code read aloud or copied by hand still works. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** The contact's code, made (and kept) the first time an email or page needs it. */
export async function referralCode(c: Pick<Contact, "id" | "referral_code">) {
	if (c.referral_code) return c.referral_code;
	for (let i = 0; i < 4; i++) {
		const code = newCode();
		try {
			const [row] = await db
				.update(ct)
				.set({ referral_code: code })
				.where(and(eq(ct.id, c.id), isNull(ct.referral_code)))
				.returning({ code: ct.referral_code });
			if (row?.code) return row.code;
			// Another send made it first.
			const now = await db
				.select({ code: ct.referral_code })
				.from(ct)
				.where(eq(ct.id, c.id))
				.get();
			if (now?.code) return now.code;
		} catch {
			// The code was taken: another try.
		}
	}
	throw new Error("referrals: no free code");
}

export const referralUrl = (code: string) => `${publicUrl()}/r/${code}`;

/** The subscriber's own page: their count, their rewards and ways to share ({{{REFERRAL_PAGE_URL}}}). */
export async function referralPageUrl(code: string) {
	const { sign } = await import("./inbound");
	return `${publicUrl()}/r/${code}/me/${await sign(`refpage:${code}`)}`;
}

const SHARE_CSS = `
main{max-width:560px;margin:0 auto;padding:40px 16px 64px}
.box{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px}
.box+.box{margin-top:16px}
.eyebrow{margin:0 0 6px;font:600 12px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
h1{margin:0;font-size:clamp(24px,5vw,30px);line-height:1.2;letter-spacing:-.02em}
.lead{margin:10px 0 0;color:var(--soft);font-size:16px;line-height:1.55}
.count{display:flex;align-items:baseline;gap:10px;margin:24px 0 6px}
.count b{font:700 52px/1 var(--heading-font);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.count span{color:var(--soft);font-size:15px}
.next{margin:0 0 10px;font-size:14px;color:var(--soft)}
.track{height:10px;border-radius:999px;background:color-mix(in srgb,var(--accent) 14%,var(--line));overflow:hidden}
.track i{display:block;height:100%;background:var(--accent);border-radius:999px}
.copy{display:flex;gap:8px;margin-top:22px}
.copy input{flex:1;min-width:0;height:44px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font:500 14px/1 var(--font);color:var(--ink);background:var(--bg)}
.share{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
h2{margin:0 0 14px;font-size:17px}
ol{list-style:none;margin:0;padding:0;display:grid;gap:10px}
li{display:flex;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--line);border-radius:14px}
li .n{flex-shrink:0;display:flex;align-items:center;justify-content:center;min-width:40px;height:40px;border-radius:12px;background:var(--bg);font:700 15px/1 var(--font);font-variant-numeric:tabular-nums;color:var(--soft)}
li.got{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
li.got .n{background:var(--accent);color:var(--on-accent)}
li .r{flex:1;min-width:0;font-weight:600}
li .s{font-size:13px;color:var(--mute);white-space:nowrap}
.foot{margin-top:18px;text-align:center;font-size:13px;color:var(--mute)}`;

/** /r/<code>/me/<signature>: a subscriber's own referral page. */
export async function handleReferralPage(code: string, signature: string) {
	const { sign } = await import("./inbound");
	const { dressBar, dressOf, dressPage } = await import("./newsletters");
	const { esc } = await import("../lib/signup-form-render");
	const expected = await sign(`refpage:${code}`);
	let diff = expected.length ^ signature.length;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
	const c = diff
		? null
		: await db
				.select({
					organization_id: ct.organization_id,
					first_name: ct.first_name,
					referrals: ct.referrals,
				})
				.from(ct)
				.where(eq(ct.referral_code, code))
				.get();
	const program = c ? await programOf(c.organization_id) : null;
	const headers = {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"content-security-policy":
			"default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'unsafe-inline'",
	};
	if (!c || !program) {
		const d = await dressOf(null, c?.organization_id ?? "");
		return new Response(
			dressPage(d, {
				title: "Not available",
				head: '<meta name="robots" content="noindex">',
				css: SHARE_CSS,
				body: `<main><div class="box"><h1>This page isn't available</h1><p class="lead">The link may be incomplete, or the referral program has ended.</p></div></main>`,
			}),
			{ status: 404, headers },
		);
	}
	const d = await dressOf(program, c.organization_id);
	const count = c.referrals ?? 0;
	const rewards = rewardsOf(program.referral_rewards);
	const next = rewards.find((r) => r.count > count) ?? null;
	const pct = next ? Math.round((count / next.count) * 100) : 100;
	const link = referralUrl(code);
	const text = `I read ${program.name} and I think you'd like it too. Subscribe here:`;
	const enc = encodeURIComponent;
	const shares = [
		["WhatsApp", `https://wa.me/?text=${enc(`${text} ${link}`)}`],
		["X", `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(link)}`],
		["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`],
		["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}`],
		["Email", `mailto:?subject=${enc(program.name)}&body=${enc(`${text}\n\n${link}`)}`],
	] as const;
	const hello = c.first_name ? `${esc(c.first_name)}, share` : "Share";
	const left = next ? next.count - count : 0;
	const body = `${dressBar(d)}<main><div class="box"><p class="eyebrow">Referral program</p><h1>${hello} ${esc(program.name)}</h1><p class="lead">${next ? `Every friend who subscribes with your link counts once they confirm. Bring ${left} more for <b>${esc(next.reward)}</b>.` : rewards.length ? "You've reached every reward. Thank you for sharing!" : "Every friend who subscribes with your link counts once they confirm."}</p>
<div class="count"><b>${count.toLocaleString("en-US")}</b><span>${count === 1 ? "friend has" : "friends have"} subscribed</span></div>
${next ? `<p class="next">${count} of ${next.count} for ${esc(next.reward)}</p><div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${Math.max(pct, 3)}%"></i></div>` : ""}
<div class="copy"><input id="link" readonly value="${esc(link)}" aria-label="Your link" onclick="this.select()"><button class="mrw-btn" type="button" id="copy">Copy link</button></div>
<div class="share">${shares.map(([l, u]) => `<a class="mrw-ghost" href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join("")}</div></div>
${rewards.length ? `<div class="box"><h2>Rewards</h2><ol>${rewards.map((r) => `<li class="${r.count <= count ? "got" : ""}"><span class="n">${r.count}</span><span class="r">${esc(r.reward)}</span><span class="s">${r.count <= count ? "Unlocked" : `${r.count - count} to go`}</span></li>`).join("")}</ol></div>` : ""}
<p class="foot">This page is just for you. Your link is the one to share.</p></main>
<script>document.getElementById("copy").addEventListener("click",function(){var i=document.getElementById("link"),b=this;i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand("copy")}).finally(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy link"},1600)})});</script>`;
	return new Response(
		dressPage(d, {
			title: `Share ${program.name}`,
			head: '<meta name="robots" content="noindex">',
			css: SHARE_CSS,
			body,
		}),
		{ headers },
	);
}

/** The brand's newsletter whose referral program is on (the first made), or null. */
export async function programOf(brand: string) {
	return (
		(await db
			.select()
			.from(nl)
			.where(and(eq(nl.organization_id, brand), eq(nl.referrals, true)))
			.orderBy(nl.created_at)
			.get()) ?? null
	);
}

/** Rewards in order, cleaned. */
export function rewardsOf(raw: ReferralReward[] | null | undefined): ReferralReward[] {
	return (raw ?? [])
		.filter((r) => Number.isInteger(r.count) && r.count > 0 && r.reward?.trim())
		.sort((a, b) => a.count - b.count);
}

/**
 * A confirmed sign-up through `code`'s link: the referrer's count goes up, and a milestone just
 * reached sends its reward.
 */
export async function creditReferral(
	brand: string,
	code: string,
	friend: Contact,
	now = Date.now(),
) {
	const referrer = await db
		.select()
		.from(ct)
		.where(and(eq(ct.referral_code, code), eq(ct.organization_id, brand)))
		.get();
	if (!referrer || referrer.id === friend.id || referrer.email === friend.email) return null;
	await db.update(ct).set({ referred_by: referrer.id }).where(eq(ct.id, friend.id));
	const [row] = await db
		.update(ct)
		.set({ referrals: sql`${ct.referrals} + 1`, updated_at: iso(now) })
		.where(eq(ct.id, referrer.id))
		.returning({ referrals: ct.referrals });
	const count = row?.referrals ?? referrer.referrals + 1;
	const program = await programOf(brand);
	const reached = rewardsOf(program?.referral_rewards).find((r) => r.count === count);
	if (program && reached)
		await reward(brand, program, { ...referrer, referrals: count }, reached, now);
	return { referrer: referrer.id, count };
}

async function reward(
	brand: string,
	program: typeof nl.$inferSelect,
	c: Contact,
	r: ReferralReward,
	now: number,
) {
	const { recordEvent } = await import("./automations");
	await recordEvent(
		brand,
		{
			event: "referral.milestone",
			contact_id: c.id,
			data: { count: r.count, reward: r.reward, newsletter: program.name },
			create_contact: false,
		},
		now,
	).catch((e) => console.error("referrals: event failed", e));
	if (!r.template_id || !program.from) return;
	try {
		const { orgOf } = await import("./brands");
		const { getTemplate } = await import("./templates");
		const { contactValues, ALL_BROADCASTS_GROUP } = await import("./contacts");
		const { fill, htmlToText } = await import("../lib/template-fill");
		const { createEmails, parseSend } = await import("./send");
		const { kickDispatcher } = await import("./dispatcher");
		const t = await getTemplate(await orgOf(brand), r.template_id);
		if (!t.published) throw new Error(`The template ${t.name} isn't published`);
		const p = t.published;
		const values: Record<string, string | number> = {
			...(await contactValues(brand, c)),
			REWARD: r.reward,
			REFERRAL_COUNT: r.count,
			REFERRAL_URL: referralUrl(await referralCode(c)),
			REFERRAL_PAGE_URL: await referralPageUrl(await referralCode(c)),
		};
		const escaped = Object.fromEntries(
			Object.entries(values).map(([k, v]) => [
				k,
				typeof v === "string" ? v.replace(/[&<>"']/g, (x) => `&#${x.charCodeAt(0)};`) : v,
			]),
		);
		const html = fill(p.html, escaped);
		const [sent] = await createEmails(
			brand,
			[
				parseSend({
					from: p.from || program.from,
					to: c.email,
					subject: fill(p.subject || `You earned ${r.reward}`, values),
					reply_to: p.reply_to ?? undefined,
					html,
					text:
						p.text === ""
							? undefined
							: p.text
								? fill(p.text, values)
								: htmlToText(html),
					unsubscribe_group: ALL_BROADCASTS_GROUP,
					template_id: t.id,
					tags: [{ name: "referral_reward", value: String(r.count) }],
				}),
			],
			{ source: "system", queue: true, kick: kickDispatcher },
		);
		if (sent?.error) console.error("referrals: reward not sent", sent.error.message);
	} catch (error) {
		console.error("referrals: reward not sent", error);
	}
}

/** The brand's best referrers, for the dashboard. */
export async function leaderboard(brand: string, limit = 10) {
	return db
		.select({
			id: ct.id,
			email: ct.email,
			first_name: ct.first_name,
			last_name: ct.last_name,
			referrals: ct.referrals,
		})
		.from(ct)
		.where(and(eq(ct.organization_id, brand), gt(ct.referrals, 0)))
		.orderBy(desc(ct.referrals), ct.created_at)
		.limit(limit);
}

/** Sign-ups that came through referrals, and how many contacts have referred anyone. */
export async function referralTotals(brand: string) {
	const row = await db
		.select({
			referred: sql<number>`SUM(CASE WHEN ${ct.referred_by} IS NOT NULL THEN 1 ELSE 0 END)`,
			referrers: sql<number>`SUM(CASE WHEN ${ct.referrals} > 0 THEN 1 ELSE 0 END)`,
		})
		.from(ct)
		.where(eq(ct.organization_id, brand))
		.get();
	return { referred: Number(row?.referred ?? 0), referrers: Number(row?.referrers ?? 0) };
}

/**
 * /r/<code>: where a share link goes. The newsletter's public page (its form carries the code),
 * or its form's own page when the archive isn't public.
 */
export async function handleReferral(code: string) {
	const c = /^[A-Za-z0-9]{4,16}$/.test(code)
		? await db
				.select({ organization_id: ct.organization_id })
				.from(ct)
				.where(eq(ct.referral_code, code))
				.get()
		: null;
	const program = c ? await programOf(c.organization_id) : null;
	if (!program?.form_id)
		return new Response("This link isn't available.", {
			status: 404,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	const to = program.public
		? `${publicUrl()}/n/${program.slug}?ref=${code}#subscribe`
		: `${publicUrl()}/subscribe/${program.form_id}?ref=${code}`;
	return new Response(null, {
		status: 302,
		headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" },
	});
}
