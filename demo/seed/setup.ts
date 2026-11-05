/**
 * The organization as its team set it up: the deployment's AWS settings, the team and roles,
 * brands, domains, keys, webhooks and templates. Each step runs the app's own function at the
 * time it happened (the clock in demo/clock.ts).
 */
import { createKey } from "@/server/api-keys";
import { createBrand } from "@/server/brands";
import { db, schema } from "@/server/db";
import { addDomain, setUpOrganization, verifyDomain } from "@/server/provision";
import { setSetting } from "@/server/settings";
import { createTemplate } from "@/server/templates";
import { at } from "../clock";
import { DEMO_USER } from "../session";
import { ORG } from "./ids";
import { draftTemplate, templates } from "./templates";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export interface Ctx {
	/** The real now the seed works back from. */
	now: number;
	/** `days` ago (fractions: hours), as ms. */
	ago: (days: number, hour?: number) => number;
	journal: string;
	token: string;
	journalToken: string;
	domains: Record<string, string>;
	team: Record<string, string>;
}

const TEAM = [
	{ id: "user_maya", name: "Maya Chen", email: "maya@acme.example", role: "admin" },
	{ id: "user_jonas", name: "Jonas Weber", email: "jonas@acme.example", role: "marketer" },
	{ id: "user_priya", name: "Priya Raman", email: "priya@acme.example", role: "writer" },
	{ id: "user_leo", name: "Leo Martins", email: "leo@acme.example", role: "support" },
	{ id: "user_sam", name: "Sam Okoro", email: "sam@acme.example", role: "developer" },
];

export async function setup(now: number): Promise<Ctx> {
	const ago = (days: number, hour = 10) => {
		const d = new Date(now - days * DAY);
		d.setUTCHours(hour, (days * 997) % 60, 0, 0);
		return d.getTime();
	};
	const ctx: Ctx = { now, ago, journal: "", token: "", journalToken: "", domains: {}, team: {} };

	await at(ago(200, 9), async () => {
		const t = new Date();
		await db
			.insert(schema.user)
			.values({ ...DEMO_USER, emailVerified: true, createdAt: t, updatedAt: t });
		await db
			.insert(schema.organization)
			.values({ id: ORG, name: "Acme", slug: "acme", createdAt: t });
		await db.insert(schema.member).values({
			id: "mem_demo",
			organizationId: ORG,
			userId: DEMO_USER.id,
			role: "owner",
			createdAt: t,
		});
		// The deployment's AWS side, as Admin › AWS leaves it.
		await setSetting("aws_account_id", "123456789012");
		await setSetting("sns_topic_arn", "arn:aws:sns:us-east-1:123456789012:mailroom-ses-events");
		await setSetting("sns_subscription_confirmed_at", new Date().toISOString());
		await setSetting("inbound_bucket", "mailroom-inbound-123456789012-us-east-1");
		await setSetting("inbound_rule_set", "mailroom");
		await setSetting("inbound_set_up_at", new Date().toISOString());
		await setSetting("inbound_dkim_tokens", JSON.stringify(["demoin1", "demoin2", "demoin3"]));
		await setUpOrganization(ORG);
	});

	// A role of the organization's own, next to the starter ones.
	await at(ago(198, 12), async () => {
		await db.insert(schema.organizationRole).values({
			id: "role_dev",
			organizationId: ORG,
			role: "developer",
			name: "Developer",
			description: "Domains, API keys and webhooks; reads everything else.",
			allPermissions: false,
			permission: JSON.stringify([
				"developers:keys",
				"developers:webhooks",
				"domains:manage",
				"emails:unmasked",
				"activity:view",
			]),
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});
	// The team, as they joined.
	for (const [i, m] of TEAM.entries())
		await at(ago(195 - i * 18, 15), async () => {
			const t = new Date();
			await db.insert(schema.user).values({
				id: m.id,
				name: m.name,
				email: m.email,
				emailVerified: true,
				createdAt: t,
				updatedAt: t,
			});
			await db.insert(schema.member).values({
				id: `mem_${m.id}`,
				organizationId: ORG,
				userId: m.id,
				role: m.role,
				createdAt: t,
			});
			ctx.team[m.name.split(" ")[0]?.toLowerCase() ?? m.id] = m.id;
		});
	await at(ago(3, 11), async () => {
		await db.insert(schema.invitation).values({
			id: "inv_demo",
			organizationId: ORG,
			email: "nina@agency.example",
			role: "writer",
			status: "pending",
			expiresAt: new Date(Date.now() + 7 * DAY),
			createdAt: new Date(),
			inviterId: "user_maya",
		});
	});

	// Domains: the app's mail, the newsletter's, and the support address's.
	await at(ago(190, 10), async () => {
		const mail = await addDomain(ORG, "mail.acme.example", "transactional");
		ctx.domains.mail = mail.id;
		await at(ago(190, 11), () => verifyDomain(ORG, mail.id));
		const news = await addDomain(ORG, "news.acme.example", "marketing");
		ctx.domains.news = news.id;
		await at(ago(189, 9), () => verifyDomain(ORG, news.id));
	});
	await at(ago(150, 14), async () => {
		const support = await addDomain(ORG, "acme.example", "transactional", {
			sending: true,
			receiving: true,
			replaceMx: true,
		});
		ctx.domains.support = support.id;
		await at(ago(150, 15), () => verifyDomain(ORG, support.id));
	});

	await at(ago(188, 16), async () => {
		ctx.token = (
			await createKey({
				organizationId: ORG,
				name: "Production app",
				permission: "full",
				createdBy: "user_sam",
			})
		).token;
		await createKey({
			organizationId: ORG,
			name: "Billing service",
			permission: "sending",
			domainId: ctx.domains.mail,
			createdBy: "user_sam",
		});
		for (const t of templates()) await createTemplate(ORG, t, { publish: true });
	});
	await at(ago(6, 17), () => createTemplate(ORG, draftTemplate()));

	// The newsletter: its own brand, with its own domain.
	await at(ago(160, 10), async () => {
		const { brand } = await createBrand(ORG, { name: "The Acme Journal" });
		ctx.journal = brand.id;
		const d = await addDomain(brand.id, "journal.acme.example", "marketing");
		ctx.domains.journal = d.id;
		await at(ago(160, 12), () => verifyDomain(brand.id, d.id));
		ctx.journalToken = (
			await createKey({
				organizationId: ORG,
				name: "Journal site",
				permission: "full",
				createdBy: "user_jonas",
			})
		).token;
	});
	return ctx;
}
