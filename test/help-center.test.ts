import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { saveChatWidget } from "@/server/chat";
import { handleChat, publicConfig } from "@/server/chat-public";
import { db, schema } from "@/server/db";
import {
	createArticle,
	dismissGap,
	handleHelpPage,
	helpCenterOf,
	helpGaps,
	saveHelpCenter,
	searchArticles,
	updateArticle,
} from "@/server/help-center";
import { createInbox } from "@/server/inboxes";
import { setSetting } from "@/server/settings";
import { seedOrg, uid, useTopic } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

beforeAll(async () => {
	await useTopic();
	await setSetting("aws_account_id", "123456789012");
	await setSetting("inbound_bucket", "mailroom-inbound-123456789012-us-east-1");
	await setSetting("inbound_rule_set", "mailroom");
	await setSetting("inbound_set_up_at", new Date().toISOString());
});

async function setUp() {
	const org = await seedOrg();
	const checkin = await createArticle(org.id, {
		title: "What time is check-in?",
		description: "Check-in and check-out times, and early arrivals",
		category: "Your stay",
		html: "<html><body><p>Check-in is from 3 pm. Early check-in depends on availability; ask the front desk.</p></body></html>",
		status: "published",
	});
	const parking = await createArticle(org.id, {
		title: "Is there parking?",
		category: "Getting here",
		html: "<p>Yes: valet parking costs 250 MXN a night.</p>",
		status: "published",
	});
	const draft = await createArticle(org.id, {
		title: "Pet policy",
		html: "<p>Dogs under 10 kg are welcome.</p>",
	});
	const center = await helpCenterOf(org.id);
	return { org, checkin, parking, draft, center: center as NonNullable<typeof center> };
}

const get = (path: string) => handleHelpPage(new Request(`https://mailroom.test${path}`));

describe("help center", () => {
	it("puts published articles on a public page, with search, views and votes", async () => {
		const { checkin, draft, center } = await setUp();
		expect(center.enabled).toBe(true);
		const home = await (await get(`/help/${center.slug}`)).text();
		expect(home).toContain("What time is check-in?");
		expect(home).toContain("Your stay");
		expect(home).not.toContain("Pet policy");
		const page = await get(`/help/${center.slug}/${checkin.slug}`);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Check-in is from 3 pm");
		expect(html).toContain("Did this answer your question?");
		expect((await get(`/help/${center.slug}/${draft.slug}`)).status).toBe(404);
		const vote = await handleHelpPage(
			new Request(`https://mailroom.test/help/${center.slug}/${checkin.slug}/vote`, {
				method: "POST",
				body: new URLSearchParams({ v: "yes" }),
			}),
		);
		expect(vote.status).toBe(303);
		const row = await db
			.select()
			.from(schema.helpArticles)
			.where(eq(schema.helpArticles.id, checkin.id))
			.get();
		expect(row).toMatchObject({ views: 1, helpful: 1 });
		// Off: the pages go away.
		await saveHelpCenter(checkin.organization_id, { enabled: false });
		expect((await get(`/help/${center.slug}`)).status).toBe(404);
	});

	it("finds the article that answers a question and keeps the ones nothing answers", async () => {
		const { org, checkin, parking, draft, center } = await setUp();
		const a = await searchArticles(org.id, "Hi! What time can we check in tomorrow?");
		expect(a.results[0]?.id).toBe(checkin.id);
		const b = await searchArticles(org.id, "do you have parking for my car");
		expect(b.results[0]?.id).toBe(parking.id);
		// Drafts are nobody's answer yet.
		expect((await searchArticles(org.id, "pet policy dogs")).results).toHaveLength(0);
		const search = await (await get(`/help/${center.slug}?q=${encodeURIComponent("airport shuttle schedule")}`)).text();
		expect(search).toContain("Nothing for");
		await searchArticles(org.id, "Airport shuttle schedule, please?", { gap: "chat" });
		const gaps = await helpGaps([org.id]);
		expect(gaps[0]).toMatchObject({ times: 2 });
		await updateArticle(org.id, draft.id, { status: "published" });
		expect((await searchArticles(org.id, "pet policy dogs")).results[0]?.id).toBe(draft.id);
		await dismissGap([org.id], "airport shuttle schedule");
		expect(await helpGaps([org.id])).toHaveLength(0);
	});

	it("suggests articles in the website chat", async () => {
		const { org, checkin, center } = await setUp();
		await db
			.update(schema.domains)
			.set({ receiving: true, receiving_status: "active", receiving_host: org.domain })
			.where(eq(schema.domains.id, org.domainId));
		const inbox = await createInbox(org.id, {
			name: "Desk",
			local_part: `desk${uid()}`,
			domain: org.domain,
		});
		const { widget } = await saveChatWidget(
			inbox,
			{ origins: ["hotel.test"], notify: ["owner@hotel.test"] },
			{ userId: null },
		);
		expect((await publicConfig({ widget, inbox })).help).toMatchObject({ title: center.title });
		const res = await handleChat(
			new Request(
				`https://mailroom.test/chat/${widget.public_key}/articles?record=1&q=${encodeURIComponent("when is check in")}`,
				{ headers: { origin: "https://hotel.test" } },
			),
		);
		const body = (await res.json()) as { articles: { title: string; url: string }[] };
		expect(body.articles[0]).toMatchObject({ title: checkin.title });
		expect(body.articles[0]?.url).toContain(`/help/${center.slug}/${checkin.slug}`);
	});
});
