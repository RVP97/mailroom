import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { HANDLE_ALPHABET, isOrgHandle, newOrgHandle, ORG_HANDLE } from "@/lib/org-handle";
import {
	APP_SECTIONS,
	handleOfPath,
	inOrg,
	isAppSectionPath,
	orgPath,
	PERSON_PAGES,
	sectionPath,
} from "@/lib/org-path";
import { ORG_HEADER, withTabHandle } from "@/lib/tab-org";
import { db, schema } from "@/server/db";
import {
	appLink,
	forgetHandles,
	giveHandle,
	handleOf,
	membershipFor,
	organizationOfHandle,
	redirectToLastUsed,
	requestedOrg,
	resolveOrgRef,
	withNewHandle,
} from "@/server/org-handles";
import migration from "../drizzle/0064_org_handles.sql?raw";
import { firstSegment, listIn, problems, serverPaths } from "../scripts/check-org-urls.mjs";
import { fakeOutside, seedOrg, uid } from "./helpers";

beforeEach(() => forgetHandles());

describe("the handle", () => {
	it("is 6 characters of the alphabet without look-alikes, with at least one digit", () => {
		for (let i = 0; i < 2000; i++) {
			const h = newOrgHandle();
			expect(h).toMatch(ORG_HANDLE);
			expect(h).toHaveLength(6);
			expect(/[0-9]/.test(h)).toBe(true);
			for (const c of h) expect(HANDLE_ALPHABET).toContain(c);
			expect(h).not.toMatch(/[01oli]/);
		}
	});

	it("uses every character about as often (no favored ones)", () => {
		const counts = new Map<string, number>();
		const n = 6000;
		for (let i = 0; i < n; i++)
			for (const c of newOrgHandle()) counts.set(c, (counts.get(c) ?? 0) + 1);
		expect(counts.size).toBe(HANDLE_ALPHABET.length);
		// Digits are a bit more common (a handle without one is drawn again), letters even.
		const letters = [...counts].filter(([c]) => /[a-z]/.test(c)).map(([, v]) => v);
		const mean = letters.reduce((a, b) => a + b, 0) / letters.length;
		for (const v of letters) expect(Math.abs(v - mean) / mean).toBeLessThan(0.2);
	});

	it("tells a handle from a public page's first segment", () => {
		expect(isOrgHandle("k7x2m9")).toBe(true);
		expect(isOrgHandle("a1b2c3")).toBe(true);
		for (const word of ["emails", "login", "privacy", "abcdef", "k7x2m", "k7x2m9a", "K7X2M9"])
			expect(isOrgHandle(word)).toBe(false);
		expect(isOrgHandle("k7-2m9")).toBe(false);
		expect(isOrgHandle(null)).toBe(false);
	});
});

describe("paths", () => {
	it("strips the handle on the way in", () => {
		expect(handleOfPath("/k7x2m9/emails/x")).toBe("k7x2m9");
		expect(handleOfPath("/emails")).toBeUndefined();
		expect(sectionPath("/k7x2m9/emails/x")).toBe("/emails/x");
		expect(sectionPath("/k7x2m9")).toBe("/");
		expect(sectionPath("/k7x2m9/")).toBe("/");
		expect(sectionPath("/account")).toBe("/account");
	});

	it("knows organization pages from person and public ones", () => {
		expect(isAppSectionPath("/")).toBe(true);
		expect(isAppSectionPath("/emails/abc")).toBe(true);
		expect(isAppSectionPath("/received/inboxes/x")).toBe(true);
		for (const p of ["/account", "/admin", "/login", "/api/emails", "/n/news", "/about"])
			expect(isAppSectionPath(p)).toBe(false);
		for (const p of PERSON_PAGES) expect(APP_SECTIONS.has(p)).toBe(false);
	});

	it("puts the handle in front of organization pages only", () => {
		expect(orgPath("k7x2m9", "/")).toBe("/k7x2m9");
		expect(orgPath("k7x2m9", "/?tab=1")).toBe("/k7x2m9?tab=1");
		expect(orgPath("k7x2m9", "/emails?x=1#y")).toBe("/k7x2m9/emails?x=1#y");
		expect(inOrg("k7x2m9", "/received/abc?tab=1")).toBe("/k7x2m9/received/abc?tab=1");
		expect(inOrg("k7x2m9", "/")).toBe("/k7x2m9");
		// Left alone: person pages, /api, public pages, one that names an organization already.
		expect(inOrg("k7x2m9", "/account")).toBe("/account");
		expect(inOrg("k7x2m9", "/admin?postmaster=ok")).toBe("/admin?postmaster=ok");
		expect(inOrg("k7x2m9", "/api/emails")).toBe("/api/emails");
		expect(inOrg("k7x2m9", "/login?invitation=1")).toBe("/login?invitation=1");
		expect(inOrg("k7x2m9", "/n/news")).toBe("/n/news");
		expect(inOrg("k7x2m9", "/a2b3c4/emails")).toBe("/a2b3c4/emails");
		expect(inOrg("k7x2m9", "https://x.test/emails")).toBe("https://x.test/emails");
		expect(inOrg("k7x2m9", "//x.test/emails")).toBe("//x.test/emails");
		// Without a (valid) handle, nothing changes.
		expect(inOrg(null, "/emails")).toBe("/emails");
		expect(inOrg("Emails", "/emails")).toBe("/emails");
	});

	it("fixes a plain link to the tab's organization", () => {
		expect(withTabHandle("/emails?x=1", "k7x2m9")).toBe("/k7x2m9/emails?x=1");
		expect(withTabHandle("/account", "k7x2m9")).toBe("/account");
		expect(withTabHandle("/a2b3c4/emails", "k7x2m9")).toBe("/a2b3c4/emails");
		expect(withTabHandle("/emails", undefined)).toBe("/emails");
	});
});

describe("the database", () => {
	it("gives existing organizations a handle of the same shape (the migration's backfill)", async () => {
		const orgs = await Promise.all(Array.from({ length: 40 }, () => seedOrg()));
		const backfill = migration
			.split("--> statement-breakpoint")
			.map((s) => s.replace(/^\s*--.*$/gm, "").trim())
			.find((s) => s.startsWith("UPDATE"));
		expect(backfill).toBeTruthy();
		await db.run(sql.raw(backfill as string));
		const rows = await db
			.select({ handle: schema.organization.handle })
			.from(schema.organization)
			.where(
				inArray(
					schema.organization.id,
					orgs.map((o) => o.id),
				),
			);
		expect(rows).toHaveLength(40);
		for (const r of rows) expect(r.handle).toMatch(ORG_HANDLE);
	});

	it("fills one made without a handle, once, and looks it up both ways", async () => {
		const org = await seedOrg();
		const handle = await handleOf(org.id);
		expect(handle).toMatch(ORG_HANDLE);
		expect(await giveHandle(org.id)).toBe(handle);
		forgetHandles();
		expect(await handleOf(org.id)).toBe(handle);
		expect(await organizationOfHandle(handle as string)).toBe(org.id);
		expect(await organizationOfHandle("z9z9z9")).toBeUndefined();
		expect(await resolveOrgRef(handle as string)).toBe(org.id);
		expect(await resolveOrgRef("z9z9z9")).toBeNull();
		expect(await resolveOrgRef(org.id)).toBe(org.id);
	});

	it("tries another handle when the unique index refuses one", async () => {
		const a = await seedOrg();
		const taken = (await handleOf(a.id)) as string;
		const b = await seedOrg();
		let tries = 0;
		await withNewHandle(async (h) => {
			tries++;
			await db
				.update(schema.organization)
				.set({ handle: tries === 1 ? taken : h })
				.where(eq(schema.organization.id, b.id));
		});
		expect(tries).toBe(2);
		expect(await handleOf(b.id)).not.toBe(taken);
	});

	it("links that leave the app open the organization they're about (a brand's: its own)", async () => {
		const org = await seedOrg();
		const handle = await handleOf(org.id);
		fakeOutside();
		const { createBrand } = await import("@/server/brands");
		const { brand } = await createBrand(org.id, { name: `Brand ${uid()}` });
		expect(await appLink(org.id, "/received/abc")).toMatch(
			new RegExp(`/${handle}/received/abc$`),
		);
		expect(await appLink(org.id, "/account")).toMatch(/[^/]\/account$/);
		// The brand has its own handle, but its links open its organization.
		expect(await handleOf(brand.id)).toMatch(ORG_HANDLE);
		expect(await appLink(brand.id, "/domains/x")).toMatch(new RegExp(`/${handle}/domains/x$`));
	});
});

describe("membership", () => {
	async function member(userId: string, organizationId: string, joined = Date.now()) {
		await db.insert(schema.member).values({
			id: `m_${uid()}`,
			organizationId,
			userId,
			role: "owner",
			createdAt: new Date(joined),
		});
	}
	async function person() {
		const id = `u_${uid()}`;
		await db.insert(schema.user).values({
			id,
			name: "P",
			email: `${id}@x.test`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		return id;
	}

	it("answers another organization's handle like one that doesn't exist", async () => {
		const mine = await seedOrg();
		const theirs = await seedOrg();
		const userId = await person();
		await member(userId, mine.id);
		const theirsId = await resolveOrgRef((await handleOf(theirs.id)) as string);
		expect(await membershipFor(userId, theirsId, true)).toBe("unavailable");
		expect(await membershipFor(userId, await resolveOrgRef("z9z9z9"), true)).toBe(
			"unavailable",
		);
		const ok = await membershipFor(userId, mine.id, true);
		expect(ok).not.toBe("unavailable");
		expect((ok as { organizationId: string }).organizationId).toBe(mine.id);
	});

	it("without a named one, the session's, else the first joined", async () => {
		const a = await seedOrg();
		const b = await seedOrg();
		const gone = await seedOrg();
		const userId = await person();
		await member(userId, a.id, 1000);
		await member(userId, b.id, 2000);
		const of = async (id: string | null) =>
			((await membershipFor(userId, id, false)) as { organizationId: string }).organizationId;
		expect(await of(b.id)).toBe(b.id);
		expect(await of(null)).toBe(a.id);
		// The session's organization they've left: their first, not a refusal.
		expect(await of(gone.id)).toBe(a.id);
	});

	it("reads the tab's organization from the header, the param or the address", () => {
		const at = (path: string, headers: Record<string, string> = {}) =>
			requestedOrg(new Request(`https://m.test${path}`, { headers }));
		expect(at("/_serverFn/x", { [ORG_HEADER]: "k7x2m9" })).toBe("k7x2m9");
		expect(at("/chat-live/x?org=k7x2m9")).toBe("k7x2m9");
		expect(at("/k7x2m9/emails")).toBe("k7x2m9");
		expect(at("/emails")).toBeUndefined();
		// Header and param naming different ones: refused.
		expect(at("/chat-live/x?org=a2b3c4", { [ORG_HEADER]: "k7x2m9" })).toBeNull();
		expect(at("/chat-live/x?org=k7x2m9", { [ORG_HEADER]: "k7x2m9" })).toBe("k7x2m9");
	});
});

describe("old links", () => {
	const last = async () => "k7x2m9";
	const none = async () => undefined;
	const get = (path: string, method = "GET") => new Request(`https://m.test${path}`, { method });

	it("sends an organization page without one to the last used, query kept, not cached", async () => {
		const res = await redirectToLastUsed(get("/emails/abc?status=failed&x=1"), last);
		expect(res?.status).toBe(307);
		expect(res?.headers.get("location")).toBe("/k7x2m9/emails/abc?status=failed&x=1");
		expect(res?.headers.get("cache-control")).toBe("private, no-store");
		expect((await redirectToLastUsed(get("/"), last))?.headers.get("location")).toBe("/k7x2m9");
		expect((await redirectToLastUsed(get("/emails", "HEAD"), last))?.status).toBe(307);
	});

	it("leaves the rest alone: signed out, person and public pages, posts, files", async () => {
		expect(await redirectToLastUsed(get("/emails"), none)).toBeNull();
		for (const p of ["/account", "/admin", "/login", "/about", "/api/emails", "/n/x"])
			expect(await redirectToLastUsed(get(p), last)).toBeNull();
		expect(await redirectToLastUsed(get("/k7x2m9/emails"), last)).toBeNull();
		expect(await redirectToLastUsed(get("/emails", "POST"), last)).toBeNull();
		expect(await redirectToLastUsed(get("/templates/a.jpg"), last)).toBeNull();
	});
});

describe("the build check", () => {
	const lists = {
		appSections: new Set(["emails", "domains"]),
		personPages: new Set(["account"]),
	};

	it("passes when the lists match the routes", () => {
		expect(
			problems({
				...lists,
				appFiles: [
					"emails.index.tsx",
					"emails.$id.tsx",
					"domains.tsx",
					"account.tsx",
					"index.tsx",
				],
				publicPaths: ["login", "about", "api"],
			}),
		).toEqual([]);
	});

	it("fails on a new page missing from the lists, or a listed one that's gone", () => {
		const found = problems({
			...lists,
			appFiles: ["emails.tsx", "calendar.tsx", "account.tsx"],
			publicPaths: [],
		});
		expect(found.join("\n")).toMatch(/missing.*calendar/);
		expect(found.join("\n")).toMatch(/isn't a page: domains/);
	});

	it("fails on a public path shaped like a handle", () => {
		const found = problems({
			...lists,
			appFiles: ["emails.tsx", "domains.tsx"],
			publicPaths: ["login", "promo2"],
		});
		expect(found.join("\n")).toMatch(/promo2/);
	});

	it("reads the real lists and the Worker's own paths", async () => {
		const source = `export const PERSON_PAGES = new Set(["account"]);\nexport const APP_SECTIONS = new Set([\n\t"emails",\n]);`;
		expect([...listIn(source, "APP_SECTIONS")]).toEqual(["emails"]);
		expect([...listIn(source, "PERSON_PAGES")]).toEqual(["account"]);
		expect(firstSegment("contacts.forms.$id.tsx")).toBe("contacts");
		expect([...serverPaths(`if (url.pathname.startsWith("/media/")) /^\\/bimi\\//`)]).toEqual([
			"media",
			"bimi",
		]);
	});

	it("matches this repository's own routes", async () => {
		const routes = import.meta.glob("../src/routes/_app/*.tsx");
		const appFiles = Object.keys(routes).map((p) => p.split("/").at(-1) as string);
		expect(
			problems({
				appFiles,
				publicPaths: [],
				appSections: new Set(APP_SECTIONS),
				personPages: new Set(PERSON_PAGES),
			}),
		).toEqual([]);
	});
});
