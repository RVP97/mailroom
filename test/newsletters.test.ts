import { env, runInDurableObject } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { renderEmail } from "@/lib/email-doc";
import { lookOf } from "@/lib/newsletter-look";
import { parseFeed } from "@/lib/rss";
import { createBroadcast, runBroadcasts, sendBroadcast } from "@/server/broadcasts";
import { createCampaign, tagLinks } from "@/server/campaigns";
import { createSegment, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import type { Dispatcher } from "@/server/dispatcher";
import { growth } from "@/server/growth";
import { checkLinks } from "@/server/link-check";
import {
	checkFeed,
	createNewsletter,
	digestDesign,
	handleNewsletterPage,
	updateNewsletter,
} from "@/server/newsletters";
import { handlePoll, pollBase, pollResults } from "@/server/polls";
import {
	handleReferral,
	handleReferralPage,
	referralCode,
	referralPageUrl,
} from "@/server/referrals";
import { confirmToken, createForm, handleSubscribe } from "@/server/signup-forms";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** Confirming a sign-up: the link's page posts its token back. */
const confirmPost = (token: string) =>
	new Request("https://mailroom.test/subscribe/confirm", {
		method: "POST",
		body: new URLSearchParams({ t: token }),
	});

const dispatcher = () => env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));

async function drain() {
	for (let i = 0; i < 50; i++) {
		await runInDurableObject(dispatcher(), (o: Dispatcher) => o.alarm());
		const left = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(inArray(schema.emails.status, ["queued", "sending"]))
			.limit(1);
		if (!left.length) break;
		await new Promise((r) => setTimeout(r, 10));
	}
	await runInDurableObject(dispatcher(), (_o: Dispatcher, state) => state.storage.deleteAlarm());
}

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);
const readable = (raw: string) =>
	raw
		.replace(
			/Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/g,
			(_, b64: string) =>
				new TextDecoder().decode(
					Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)),
				),
		)
		.replace(/=\r?\n/g, "");

beforeEach(async () => {
	await db.delete(schema.emailBodies);
	await db.delete(schema.emails);
});

async function setUp() {
	const org = await seedOrg();
	const segment = await createSegment(org.id, { name: "Readers" });
	const add = async (email: string, first?: string) =>
		(
			await upsertContact(org.id, {
				email,
				first_name: first,
				segments: [segment.id],
				source: "import",
			})
		).contact;
	const ana = await add(`ana-${uid()}@reader.test`, "Ana");
	const luis = await add(`luis-${uid()}@reader.test`, "Luis");
	const form = await createForm(org.id, {
		name: "Footer",
		title: "The news",
		from: `hola@${org.domain}`,
		segment_id: segment.id,
	});
	const n = await createNewsletter(org.id, {
		name: `Harbor News ${uid()}`,
		description: "News from the hotel",
		segment_id: segment.id,
		from: `News <news@${org.domain}>`,
		form_id: form.id,
	});
	return { org, segment, ana, luis, form, n };
}

async function sendIssue(org: { id: string; domain: string }, o: Record<string, unknown>) {
	const x = await createBroadcast(org.id, org.id, {
		from: `News <news@${org.domain}>`,
		...o,
	});
	await sendBroadcast(org.id, x.id);
	await runBroadcasts(Date.now(), x.id);
	return x;
}

describe("newsletters", () => {
	it("puts sent issues on the public archive with a web version, feed and sign-up form", async () => {
		const aws = fakeOutside();
		const { org, segment, n } = await setUp();
		const x = await sendIssue(org, {
			segment_id: segment.id,
			newsletter_id: n.id,
			subject: "Summer at the hotel",
			preview_text: "Pool, terrace and a new menu",
			html: '<html><head><title>x</title></head><body><p>Hi {{{FIRST_NAME|there}}}</p><a href="{{{WEB_VERSION_URL}}}">Read online</a></body></html>',
		});
		const kept = await createBroadcast(org.id, org.id, {
			segment_id: segment.id,
			newsletter_id: n.id,
			subject: "Members only",
			html: "<p>secret</p>",
			web: false,
			from: `news@${org.domain}`,
		});
		await sendBroadcast(org.id, kept.id);
		await runBroadcasts(Date.now(), kept.id);
		await drain();

		const row = await db
			.select()
			.from(schema.broadcasts)
			.where(eq(schema.broadcasts.id, x.id))
			.get();
		expect(row?.slug).toBe("summer-at-the-hotel");
		const issueUrl = `https://mailroom.test/n/${n.slug}/summer-at-the-hotel`;
		// Each email links to its web version.
		const raw = readable(rawOf(aws.sends[0] as never));
		expect(raw).toContain(`/n/${n.slug}/summer-at-the-hotel`);

		const archive = await handleNewsletterPage(
			new Request(`https://mailroom.test/n/${n.slug}`),
		);
		const page = await archive.text();
		expect(archive.status).toBe(200);
		expect(page).toContain("Summer at the hotel");
		expect(page).toContain("Pool, terrace and a new menu");
		expect(page).not.toContain("Members only");
		expect(page).toContain(`/subscribe/${n.form_id}`);

		const issue = await handleNewsletterPage(new Request(issueUrl));
		const html = await issue.text();
		expect(issue.status).toBe(200);
		// Read by nobody in particular: the fallback, and the archive's bar and sign-up.
		expect(html).toContain("Hi there");
		expect(html).toContain("<title>Summer at the hotel");
		expect(html).toContain("Subscribe");
		expect(issue.headers.get("content-security-policy")).toContain("default-src 'none'");

		const feed = await (
			await handleNewsletterPage(new Request(`https://mailroom.test/n/${n.slug}/feed.xml`))
		).text();
		expect(feed).toContain("<title>Summer at the hotel</title>");
		expect(feed).not.toContain("Members only");

		// The view link of an issue goes to its archive page; a kept-off one has its own.
		const view = await handleNewsletterPage(new Request(`https://mailroom.test/view/${x.id}`));
		expect(view.status).toBe(301);
		const own = await handleNewsletterPage(
			new Request(`https://mailroom.test/view/${kept.id}`),
		);
		expect(own.status).toBe(200);
		expect(await own.text()).toContain("noindex");

		// Off the web: nothing public.
		await updateNewsletter(org.id, n.id, { public: false });
		expect((await handleNewsletterPage(new Request(issueUrl))).status).toBe(404);
	});

	it("turns new RSS posts into a draft issue, never the ones there before", async () => {
		fakeOutside();
		const { org, n } = await setUp();
		await updateNewsletter(org.id, n.id, { rss_url: "https://blog.test/feed" });
		const now = Date.now();
		const feed = (items: { t: string; l: string }[]) => async () =>
			parseFeed(
				`<rss><channel><title>Blog</title>${items.map((i) => `<item><title>${i.t}</title><link>${i.l}</link><description><![CDATA[<p>About ${i.t}</p><img src="https://blog.test/${i.l.length}.jpg">]]></description><pubDate>${new Date(now).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`,
			);
		const first = await db
			.select()
			.from(schema.newsletters)
			.where(eq(schema.newsletters.id, n.id))
			.get();
		expect(
			await checkFeed(
				first as never,
				now,
				feed([{ t: "Old post", l: "https://blog.test/old" }]),
			),
		).toBeNull();
		const again = await db
			.select()
			.from(schema.newsletters)
			.where(eq(schema.newsletters.id, n.id))
			.get();
		const made = await checkFeed(
			again as never,
			now,
			feed([
				{ t: "New pool", l: "https://blog.test/pool" },
				{ t: "Old post", l: "https://blog.test/old" },
			]),
		);
		expect(made).toBeTruthy();
		const issue = await db
			.select()
			.from(schema.broadcasts)
			.where(eq(schema.broadcasts.id, made as string))
			.get();
		expect(issue).toMatchObject({ subject: "New pool", newsletter_id: n.id, status: "draft" });
		expect(issue?.html).toContain("https://blog.test/pool");
		expect(issue?.html).toContain("https://blog.test/22.jpg");
		expect(issue?.html).not.toContain("Old post");
		expect(issue?.rss_items).toEqual(["https://blog.test/pool"]);
	});

	it("reads Atom feeds too", () => {
		const f = parseFeed(
			`<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><title type="html">A &amp; B</title><link rel="alternate" href="https://blog.test/ab"/><summary>Short &lt;b&gt;text&lt;/b&gt;</summary><updated>2026-11-01T10:00:00Z</updated></entry></feed>`,
		);
		expect(f.title).toBe("Blog");
		expect(f.items[0]).toMatchObject({
			title: "A & B",
			link: "https://blog.test/ab",
			summary: "Short text",
			published: "2026-11-01T10:00:00.000Z",
		});
		const design = digestDesign({ name: "News", accent: null }, f.items);
		expect(renderEmail(design)).toContain("Read more");
	});

	it("lays posts out in the newsletter's chosen style, color and fonts", () => {
		const items = [
			{
				title: "Pool",
				link: "https://b.test/pool",
				summary: "Open",
				image: "https://b.test/p.jpg",
				published: null,
			},
			{
				title: "Menu",
				link: "https://b.test/menu",
				summary: "New",
				image: null,
				published: null,
			},
		];
		const base = {
			name: "News",
			accent: "#7a1d35",
			look: { font: "dm-sans", heading_font: "fraunces" },
		};
		const titles = digestDesign(
			{ ...base, rss_style: "titles", rss_intro: "This week" },
			items as never,
		);
		expect(titles.blocks.some((b) => b.type === "button")).toBe(false);
		expect(renderEmail(titles)).toContain("This week");
		expect(renderEmail(titles)).toContain('href="https://b.test/menu"');
		const compact = digestDesign({ ...base, rss_style: "compact" }, items as never);
		expect(compact.blocks.some((b) => b.type === "columns")).toBe(true);
		expect(compact.theme).toMatchObject({
			accent: "#7a1d35",
			heading_font: "book",
			font: "modern",
		});
	});

	it("dresses the public pages in the newsletter's look, without the email's footer", async () => {
		fakeOutside();
		const { org, segment, n } = await setUp();
		await updateNewsletter(org.id, n.id, {
			accent: "#7a1d35",
			look: {
				cover: "https://cdn.test/cover.jpg",
				logo: "https://cdn.test/logo.png",
				font: "dm-sans",
				heading_font: "fraunces",
				theme: "dark",
				layout: "cards",
				links: [{ label: "Book a room", url: "https://hotel.test" }],
			},
		});
		await sendIssue(org, {
			segment_id: segment.id,
			newsletter_id: n.id,
			subject: "Autumn",
			design: {
				version: 1,
				theme: {},
				blocks: [
					{
						id: "a",
						type: "image",
						src: "https://cdn.test/autumn.jpg",
						alt: "",
						href: "",
						width: 100,
						align: "center",
					},
					{ id: "b", type: "text", html: "<p>Leaves</p>", align: "left" },
					{
						id: "c",
						type: "footer",
						html: "<p>Why you got this</p>",
						unsubscribe: "Unsubscribe",
					},
				],
			},
		});
		await drain();
		const page = await (
			await handleNewsletterPage(new Request(`https://mailroom.test/n/${n.slug}`))
		).text();
		expect(page).toContain("https://cdn.test/cover.jpg");
		expect(page).toContain("https://cdn.test/logo.png");
		expect(page).toContain("family=Fraunces");
		expect(page).toContain('class="cards"');
		expect(page).toContain("https://cdn.test/autumn.jpg");
		expect(page).toContain("Book a room");
		expect(page).toContain("color-scheme:dark");
		const issue = await (
			await handleNewsletterPage(new Request(`https://mailroom.test/n/${n.slug}/autumn`))
		).text();
		expect(issue).toContain("Leaves");
		expect(issue).not.toContain("Why you got this");
		expect(issue).toContain('property="og:image" content="https://cdn.test/autumn.jpg"');
		// A bad look is cleaned, not trusted.
		expect(
			lookOf({
				logo: "javascript:alert(1)",
				font: "comic" as never,
				links: [{ label: "x", url: "ftp://no" }],
			}),
		).toMatchObject({ logo: "brand", font: "system", links: [] });
	});
});

describe("referrals", () => {
	it("credits a confirmed sign-up through someone's link and sends the milestone's reward", async () => {
		fakeOutside();
		const { org, ana, form, n } = await setUp();
		await updateNewsletter(org.id, n.id, {
			referrals: true,
			referral_rewards: [{ count: 1, reward: "A free breakfast" }],
		});
		const code = await referralCode(ana);
		expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
		expect(await referralCode({ id: ana.id, referral_code: null })).toBe(code);

		const go = await handleReferral(code);
		expect(go.status).toBe(302);
		expect(go.headers.get("location")).toContain(`/n/${n.slug}?ref=${code}`);
		// The archive's form carries the code.
		const page = await (
			await handleNewsletterPage(new Request(`https://mailroom.test/n/${n.slug}?ref=${code}`))
		).text();
		expect(page).toContain(`name="ref" value="${code}"`);

		const friend = `friend-${uid()}@reader.test`;
		const token = await confirmToken({ f: form.id, e: friend, r: code });
		await handleSubscribe(confirmPost(token));
		const referrer = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.id, ana.id))
			.get();
		expect(referrer?.referrals).toBe(1);
		const added = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.email, friend))
			.get();
		expect(added).toMatchObject({ referred_by: ana.id, source: "referral" });

		// Confirming again (already a contact) doesn't count twice; nor does a code for oneself.
		await handleSubscribe(confirmPost(token));
		const self = await confirmToken({ f: form.id, e: ana.email, r: code });
		await handleSubscribe(confirmPost(self));
		const after = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.id, ana.id))
			.get();
		expect(after?.referrals).toBe(1);

		// Their own page shows the count and the next reward, only through the signed link.
		const url = await referralPageUrl(code);
		const sig = url.split("/me/")[1] ?? "";
		const mine = await handleReferralPage(code, sig);
		expect(mine.status).toBe(200);
		const html = await mine.text();
		expect(html).toContain("A free breakfast");
		expect(html).toContain(`/r/${code}`);
		expect((await handleReferralPage(code, `${sig.slice(0, -2)}xx`)).status).toBe(404);
	});
});

describe("polls", () => {
	it("records one-click answers, signed per contact, and counts them", async () => {
		const aws = fakeOutside();
		const { org, segment, ana, luis } = await setUp();
		const design = {
			version: 1,
			theme: {},
			blocks: [
				{ id: "p1", type: "poll", question: "Pool or beach?", options: ["Pool", "Beach"] },
			],
		};
		const x = await sendIssue(org, {
			segment_id: segment.id,
			subject: "Quick question",
			design,
		});
		await drain();
		const raw = readable(rawOf(aws.sends[0] as never));
		expect(raw).toMatch(/\/poll\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w-]+\/p1\/1/);

		const base = await pollBase(x.id, ana.id);
		const vote = await handlePoll(new Request(`${base}/p1/1`));
		expect(vote.status).toBe(200);
		expect(await vote.text()).toContain("100%");
		// A changed mind replaces the answer.
		await handlePoll(new Request(`${base}/p1/0`));
		await handlePoll(new Request(`${await pollBase(x.id, luis.id)}/p1/0`));
		// Someone else's link with a made-up signature counts nothing.
		const forged = (await pollBase(x.id, luis.id)).replace(
			/\/[\w-]+$/,
			"/AAAAAAAAAAAAAAAAAAAAAAAA",
		);
		expect((await handlePoll(new Request(`${forged}/p1/1`))).status).toBe(404);

		const saved = await db
			.select()
			.from(schema.broadcasts)
			.where(eq(schema.broadcasts.id, x.id))
			.get();
		const [r] = await pollResults(x.id, saved?.design);
		expect(r).toMatchObject({ question: "Pool or beach?", total: 2 });
		expect(r?.options.map((o) => o.votes)).toEqual([2, 0]);
	});
});

describe("campaigns", () => {
	it("tags links with utm_campaign and leaves out contacts another of its emails reached", async () => {
		const aws = fakeOutside();
		const { org, segment, ana } = await setUp();
		const other = await createSegment(org.id, { name: "Locals" });
		await upsertContact(org.id, { email: ana.email, segments: [other.id] });
		const c = await createCampaign(org.id, { name: "Summer Promo 2026" });
		expect(c.utm_campaign).toBe("summer-promo-2026");
		await sendIssue(org, {
			segment_id: segment.id,
			campaign_id: c.id,
			subject: "Summer offer",
			html: '<p><a href="https://hotel.test/offer?x=1">Book</a> <a href="https://hotel.test/?utm_campaign=own">Own</a></p>',
		});
		const second = await sendIssue(org, {
			segment_id: other.id,
			campaign_id: c.id,
			campaign_dedupe: true,
			subject: "Locals offer",
			html: "<p>Hi</p>",
		});
		await drain();
		const raws = aws.sends.map((s) => readable(rawOf(s as never)));
		const first = raws.find((r) => r.includes("Summer offer")) as string;
		expect(first).toContain(
			"utm_source=mailroom&amp;utm_medium=email&amp;utm_campaign=summer-promo-2026",
		);
		expect(first).toContain("utm_campaign=own");
		// Ana got the first email: the second, which skips those reached, didn't go to her.
		const toSecond = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.broadcast_id, second.id));
		expect(toSecond).toHaveLength(0);
	});

	it("leaves Mailroom's own links and placeholders alone", () => {
		const out = tagLinks(
			'<a href="{{{UNSUBSCRIBE_URL}}}">x</a><a href="mailto:a@b.c">m</a><a href="https://shop.test/a?b=1&amp;c=2">s</a>',
			"promo",
		);
		expect(out).toContain('href="{{{UNSUBSCRIBE_URL}}}"');
		expect(out).toContain('href="mailto:a@b.c"');
		expect(out).toContain(
			"b=1&amp;c=2&amp;utm_source=mailroom&amp;utm_medium=email&amp;utm_campaign=promo",
		);
	});
});

describe("growth and the link check", () => {
	it("counts who joined and left each day, by source", async () => {
		fakeOutside();
		const { org, luis } = await setUp();
		await upsertContact(org.id, { email: `api-${uid()}@reader.test` });
		await upsertContact(org.id, { email: luis.email, unsubscribed: true });
		const g = await growth(org.id, { days: 7 });
		expect(g).toMatchObject({ joined: 3, left: 1, net: 2, subscribed: 2 });
		expect(g.series).toHaveLength(7);
		expect(g.series.at(-1)).toMatchObject({ joined: 3, left: 1, subscribed: 2 });
		expect(g.sources.find((s) => s.kind === "import")).toMatchObject({ joined: 2, stayed: 1 });
		expect(g.sources.find((s) => s.kind === "api")?.joined).toBe(1);
		const c = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.id, luis.id))
			.get();
		expect(c?.unsubscribed_at).toBeTruthy();
	});

	it("opens each link and reports the broken ones", async () => {
		fakeOutside({
			extra: (url) =>
				url.host === "ok.test"
					? new Response("", { status: 200 })
					: url.host === "gone.test"
						? new Response("", { status: 404 })
						: url.host === "robots.test"
							? new Response("", { status: 403 })
							: undefined,
		});
		const r = await checkLinks(
			'<a href="https://ok.test/a">a</a><a href="https://gone.test/b">b</a><a href="https://robots.test/">c</a><a href="{{{WEB_VERSION_URL}}}">v</a><a href="https://ok.test/a">again</a>',
		);
		expect(r.checked.map((l) => [l.url, l.state])).toEqual([
			["https://ok.test/a", "ok"],
			["https://gone.test/b", "broken"],
			["https://robots.test/", "unsure"],
		]);
	});
});
