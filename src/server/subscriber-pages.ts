import { eq } from "drizzle-orm";
import {
	type BrandDress,
	type PageState,
	pageOf,
	subscriberPageHtml as render,
	type SubscriberPage,
} from "../lib/subscriber-page";
import { db, schema } from "./db";
import { publicUrl } from "./public-host";
import { iso } from "./time";

export type { PageState };

/** A brand's unsubscribe page as saved (with defaults), and whether it was ever saved. */
export async function getSubscriberPage(brand: string) {
	const row = await db
		.select({ look: schema.subscriberPages.look, at: schema.subscriberPages.updated_at })
		.from(schema.subscriberPages)
		.where(eq(schema.subscriberPages.organization_id, brand))
		.get();
	return { page: pageOf(row?.look), saved: !!row, updated_at: row?.at ?? null };
}

export async function saveSubscriberPage(brand: string, raw: unknown, userId: string | null) {
	const page = pageOf(raw);
	const now = iso(Date.now());
	await db
		.insert(schema.subscriberPages)
		.values({ organization_id: brand, look: page, updated_by: userId, updated_at: now })
		.onConflictDoUpdate({
			target: schema.subscriberPages.organization_id,
			set: { look: page, updated_by: userId, updated_at: now },
		});
	return page;
}

export async function resetSubscriberPage(brand: string) {
	await db
		.delete(schema.subscriberPages)
		.where(eq(schema.subscriberPages.organization_id, brand));
}

const absolute = (u: string | null) => (u?.startsWith("/") ? `${publicUrl()}${u}` : u);

/** What the page takes from the brand: its name, logo and kit accent. */
export async function brandDress(brand: string): Promise<BrandDress> {
	const [{ orgLogos }, { getKit }] = await Promise.all([
		import("./org-logos"),
		import("./library"),
	]);
	const [row, logos, kit] = await Promise.all([
		db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, brand))
			.get(),
		orgLogos([brand]),
		getKit(brand).catch(() => null),
	]);
	return {
		name: row?.name ?? "",
		logo: absolute(logos.get(brand)?.url ?? null),
		accent: kit?.accent ?? null,
	};
}

/** The page for a reader, with the deployment's address for a logo of its own. */
export function subscriberPageHtml(
	p: SubscriberPage,
	o: Omit<Parameters<typeof render>[1], "origin">,
) {
	return render(p, { ...o, origin: publicUrl() });
}
