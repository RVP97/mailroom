import { eq } from "drizzle-orm";
import {
	PAGE_ICONS,
	pageOf,
	pageText,
	renderSubscriberPage,
	type SubscriberPage,
	type TextKey,
} from "../lib/subscriber-page";
import { db, schema } from "./db";
import { publicUrl } from "./public-host";
import { iso } from "./time";

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
export async function brandDress(brand: string) {
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

/** The states the page can be in. */
export type PageState = "ask" | "done" | "back" | "invalid";

/**
 * The page's HTML in a state: its heading, its line, its button, and (`prefs`) the preferences
 * form already drawn. `form` draws a button's form (the live page posts to its own link).
 */
export function subscriberPageHtml(
	p: SubscriberPage,
	o: {
		lang: "en" | "es";
		state: PageState;
		name: string;
		email: string;
		dress: { name: string; logo: string | null; accent: string | null };
		form: (action: "unsubscribe" | "resubscribe", label: string, quiet: boolean) => string;
		prefs?: string;
	},
) {
	const v = { name: o.name, email: o.email };
	const t = (k: TextKey) => pageText(p, o.lang, k, v);
	const title = o.lang === "es" ? "Darse de baja" : "Unsubscribe";
	let body: string;
	if (o.state === "invalid")
		body = `<h1>${o.lang === "es" ? "Este enlace ya no sirve" : "This link doesn't work"}</h1><p>${
			o.lang === "es"
				? "Use el enlace para darse de baja de un correo reciente."
				: "Use the unsubscribe link in a recent email instead."
		}</p>`;
	else if (o.state === "ask")
		body = `<h1>${t("ask")}</h1><p>${t("who")}</p><div class="acts">${o.form("unsubscribe", t("out"), false)}</div>`;
	else if (o.state === "done") {
		const sorry = t("sorry");
		body = `<h1>${t("done")}</h1>${sorry ? `<p>${sorry}</p>` : ""}${p.resubscribe ? `<div class="acts">${o.form("resubscribe", t("back"), true)}</div>` : ""}`;
	} else {
		const line = t("backBody");
		body = `<h1>${t("backDone")}</h1>${line ? `<p>${line}</p>` : ""}<div class="acts">${o.form("unsubscribe", t("out"), true)}</div>`;
	}
	body = `<div class="icon">${PAGE_ICONS[o.state]}</div>${body}`;
	const logo = p.logo === "none" ? null : p.logo === "brand" ? o.dress.logo : absolute(p.logo);
	return renderSubscriberPage(p, {
		lang: o.lang,
		title,
		body: `${body}${o.state === "invalid" ? "" : (o.prefs ?? "")}`,
		logo,
		accent: o.dress.accent,
		brand: o.dress.name,
	});
}

/** The dashboard's preview: a page not saved yet, in one state, with made-up topics. */
export async function previewSubscriberPage(
	brand: string,
	raw: unknown,
	state: PageState,
	lang: "en" | "es",
) {
	const p = pageOf(raw);
	const dress = await brandDress(brand);
	const l = p.language === "auto" ? lang : p.language;
	const t = (k: TextKey) => pageText(p, l, k, { name: dress.name, email: "" });
	const topics =
		l === "es"
			? [
					["Novedades", "Lo nuevo, una vez al mes."],
					["Ofertas", "Precios especiales y promociones."],
				]
			: [
					["News", "What's new, once a month."],
					["Offers", "Special prices and promotions."],
				];
	const prefs = `<section><h2>${t("prefs")}</h2><form><div class="topics">${topics
		.map(
			([n, d], i) =>
				`<label class="topic"><span>${n}<small>${d}</small></span><input type="checkbox"${i === 0 ? " checked" : ""}></label>`,
		)
		.join("")}</div><button type="button" class="quiet">${t("save")}</button></form></section>`;
	// The preview draws again on every change: no entrance animation each time.
	const still = "<style>*{animation:none!important}</style></head>";
	return subscriberPageHtml(p, {
		lang: l,
		state,
		name: dress.name || "Harbor Inn",
		email: "ana@example.com",
		dress,
		form: (_a, label, quiet) =>
			`<form><button type="button"${quiet ? ' class="quiet"' : ""}>${label}</button></form>`,
		prefs: state === "back" ? "" : prefs,
	}).replace("</head>", still);
}
