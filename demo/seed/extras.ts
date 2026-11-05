/**
 * The rest of what an organization that's been sending for months has: its activity log and
 * comments, brand kits and logos, DMARC reports, Gmail Postmaster numbers, domain health, a
 * suppression added by hand, SMTP credentials, and the deployment's AWS costs.
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { logActivity } from "@/server/activity";
import { addComment } from "@/server/comments";
import { db, schema } from "@/server/db";
import { checkDomainHealth } from "@/server/deliverability";
import { parseAggregateReport, storeReport } from "@/server/dmarc-reports";
import { saveKit, saveSection } from "@/server/library";
import { setOrgLogo } from "@/server/org-logos";
import { setSetting } from "@/server/settings";
import { createSmtpCredentials } from "@/server/smtp";
import { addSuppression } from "@/server/suppressions";
import { at } from "../clock";
import { settle } from "../shims/cloudflare-workers";
import { appFooter, button, h, logo, p } from "./designs";
import { ORG } from "./ids";
import { type Ctx, DAY, HOUR } from "./setup";
import { random } from "./time";

const svg = (name: string) =>
	`data:image/svg+xml;base64,${Buffer.from(readFileSync(new URL(`../public/media/${name}`, import.meta.url))).toString("base64")}`;

export async function extras(ctx: Ctx) {
	const r = random(99);
	const step = async (t: number, fn: () => Promise<unknown>) => {
		await at(t, fn);
		await settle();
	};
	const J = ctx.journal;

	// Logos and brand kits.
	await step(ctx.ago(199, 10), () => setOrgLogo(ORG, svg("acme-mark.svg")));
	await step(ctx.ago(160, 11), () => setOrgLogo(J, svg("journal-mark.svg")));
	await step(ctx.ago(150, 16), () =>
		saveKit(
			ORG,
			{
				colors: [
					{ name: "Indigo", value: "#4f46e5" },
					{ name: "Ink", value: "#18181b" },
					{ name: "Mist", value: "#eef2ff" },
				],
				background: "#f4f4f5",
				surface: "#ffffff",
				text: "#3f3f46",
				heading: "#18181b",
				accent: "#4f46e5",
				button_text: "#ffffff",
				font: "inter",
				heading_font: "inter",
				radius: 12,
				locked: false,
			},
			"user_jonas",
		),
	);
	await step(ctx.ago(150, 17), () =>
		saveKit(
			J,
			{
				colors: [
					{ name: "Amber", value: "#b45309" },
					{ name: "Paper", value: "#faf7f2" },
				],
				background: "#faf7f2",
				surface: "#ffffff",
				text: "#292524",
				heading: "#1c1917",
				accent: "#b45309",
				button_text: "#ffffff",
				font: "georgia",
				heading_font: "book",
				radius: 4,
				locked: true,
			},
			"user_priya",
		),
	);
	await step(ctx.ago(120, 12), () =>
		saveSection({
			organizationId: ORG,
			name: "Acme header",
			blocks: [logo()],
			userId: "user_jonas",
		} as never),
	);
	await step(ctx.ago(118, 12), () =>
		saveSection({
			organizationId: ORG,
			name: "Webinar sign-up",
			blocks: [
				h("Join us live", 2),
				p("45 minutes with the team, questions at the end."),
				button("Save your seat", "https://acme.example/webinar"),
			],
			userId: "user_jonas",
		} as never),
	);
	await step(ctx.ago(117, 12), () =>
		saveSection({
			organizationId: ORG,
			name: "Legal footer",
			blocks: [appFooter()],
			userId: "user_priya",
		} as never),
	);

	// SMTP for the old billing system, and an address support asked to block.
	await step(ctx.ago(110, 15), () =>
		createSmtpCredentials(ORG, "user_sam").catch((e) => console.warn("[demo] smtp", e.message)),
	);
	await step(ctx.ago(33, 12), () =>
		addSuppression(
			ORG,
			"chargeback@example.com",
			"Asked us never to email again (ticket #4182)",
		),
	);

	// DMARC reports from the big mailbox providers, every day.
	const ses = ["54.240.8.21", "54.240.8.94", "54.240.11.3", "23.251.234.17", "76.223.180.9"];
	for (let d = 30; d >= 1; d--) {
		const begin = Math.floor((ctx.now - d * DAY) / 86_400_000) * 86_400;
		for (const [reporter, email, scale] of [
			["google.com", "noreply-dmarc-support@google.com", 1],
			["Enterprise Outlook", "dmarcreport@microsoft.com", 0.35],
			["Yahoo", "dmarc_support@yahoo.com", 0.15],
		] as const) {
			const rows: string[] = [];
			for (const [from, n] of [
				["mail.acme.example", 60],
				["news.acme.example", 40],
				["acme.example", 6],
			] as const) {
				const count = Math.max(1, Math.round(n * scale * (0.6 + r())));
				rows.push(record(ses[Math.floor(r() * ses.length)] as string, count, from, true));
			}
			// Now and then, someone else sending as acme.example (and failing).
			if (reporter === "google.com" && d % 6 === 2)
				rows.push(record("203.0.113.66", 3 + Math.floor(r() * 9), "acme.example", false));
			const xml = `<?xml version="1.0"?><feedback><report_metadata><org_name>${reporter}</org_name><email>${email}</email><report_id>${reporter.replace(/\W/g, "")}-${begin}</report_id><date_range><begin>${begin}</begin><end>${begin + 86_399}</end></date_range></report_metadata><policy_published><domain>acme.example</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><sp>quarantine</sp><pct>100</pct></policy_published>${rows.join("")}</feedback>`;
			const parsed = parseAggregateReport(xml);
			if (parsed)
				await step(ctx.ago(d - 1, 6 + Math.floor(r() * 4)), () => storeReport(parsed));
		}
	}

	// Gmail Postmaster Tools, connected.
	await step(ctx.ago(100, 10), async () => {
		await setSetting("postmaster_account", "postmaster@acme.example");
		await setSetting("postmaster_connected_at", new Date().toISOString());
		await setSetting("postmaster_refresh_token", "demo");
		const ds = await db.select().from(schema.domains);
		for (const d of ds.filter((x) => x.sending))
			await db.insert(schema.postmasterDomains).values({
				domain_id: d.id,
				organization_id: d.organization_id,
				status: "verified",
				token: `google-site-verification=demo${d.id.slice(0, 8)}`,
				compliance: {
					requirements: [
						{ requirement: "SPF", status: "COMPLIANT" },
						{ requirement: "DKIM", status: "COMPLIANT" },
						{ requirement: "DMARC", status: "COMPLIANT" },
						{ requirement: "DMARC_ALIGNMENT", status: "COMPLIANT" },
						{ requirement: "TLS", status: "COMPLIANT" },
						{ requirement: "SPAM_RATE", status: "COMPLIANT" },
					],
					deliverability: { state: "COMPLIANT", reason: null },
					oneClickUnsubscribe: {
						status: d.purpose === "marketing" ? "COMPLIANT" : null,
						reason: null,
					},
				},
				checked_at: new Date().toISOString(),
			});
		for (const d of ds.filter((x) => x.sending))
			for (let i = 60; i >= 2; i--)
				await db.insert(schema.postmasterStats).values({
					domain: d.name,
					organization_id: d.organization_id,
					day: new Date(ctx.now - i * DAY).toISOString().slice(0, 10),
					spam_rate:
						d.purpose === "marketing"
							? Math.round(r() * 12) / 10_000
							: r() < 0.7
								? 0
								: 0.0002,
					spf_rate: 1,
					dkim_rate: 1,
					dmarc_rate: 1,
					tls_rate: 0.998 + r() * 0.002,
					delivery_error_rate: r() < 0.85 ? 0 : Math.round(r() * 30) / 10_000,
				});
	});
	await setSetting("postmaster_connected_at", new Date(ctx.ago(100)).toISOString());

	// SNS's last delivery of SES's events (Admin › AWS).
	await setSetting("sns_last_event_at", new Date(ctx.now - 2 * 60_000).toISOString());
	// Domain health, checked this morning.
	for (const d of await db.select().from(schema.domains))
		await step(ctx.ago(0, 4) - 6 * HOUR, () => checkDomainHealth(d, { notify: false }));

	// The November draft's review, in comments.
	const draft = await db
		.select()
		.from(schema.broadcasts)
		.where(
			and(eq(schema.broadcasts.organization_id, ORG), eq(schema.broadcasts.status, "draft")),
		)
		.get();
	if (draft) {
		await step(ctx.ago(0, 2) + 20 * 60_000, () =>
			addComment({
				organizationId: ORG,
				type: "broadcast",
				id: draft.id,
				userId: "user_priya",
				body: "Ready for a look. I kept it to two items so offline mode gets the attention.",
			}),
		);
		await step(ctx.ago(0, 2) + 50 * 60_000, () =>
			addComment({
				organizationId: ORG,
				type: "broadcast",
				id: draft.id,
				userId: "user_jonas",
				body: "Looks great. Can we add a screenshot of team templates before it goes?",
			}),
		);
	}

	// The activity log: what the team did, as the dashboard records it.
	const log = (
		days: number,
		hour: number,
		userId: string,
		action: string,
		type: string,
		name: string,
		id?: string,
	) =>
		step(ctx.ago(days, hour), () =>
			logActivity({
				organizationId: ORG,
				userId,
				action,
				subject: { type, id: id ?? null, name },
			}),
		);
	const broadcasts = await db.select().from(schema.broadcasts);
	for (const b of broadcasts) {
		const by = b.created_by ?? "user_jonas";
		await step(Date.parse(b.created_at), () =>
			logActivity({
				organizationId: ORG,
				userId: by,
				action: "broadcast.created",
				subject: { type: "broadcast", id: b.id, name: b.name },
			}),
		);
		if (b.started_at || b.scheduled_at)
			await step(Date.parse(b.created_at) + 30 * 60_000, () =>
				logActivity({
					organizationId: ORG,
					userId: by,
					action: b.status === "scheduled" ? "broadcast.scheduled" : "broadcast.sent",
					subject: { type: "broadcast", id: b.id, name: b.name },
				}),
			);
	}
	await log(190, 10, "user_sam", "domain.added", "domain", "mail.acme.example");
	await log(189, 9, "user_sam", "domain.added", "domain", "news.acme.example");
	await log(188, 16, "user_sam", "api_key.created", "api_key", "Production app");
	await log(160, 10, "user_maya", "brand.created", "brand", "The Acme Journal");
	await log(150, 14, "user_sam", "domain.added", "domain", "acme.example");
	await log(150, 15, "user_sam", "domain.receiving_changed", "domain", "acme.example");
	await log(140, 11, "user_leo", "inbox.created", "inbox", "support@acme.example");
	await log(140, 12, "user_sam", "inbox.created", "inbox", "billing@acme.example");
	await log(
		140,
		12,
		"user_sam",
		"inbox_credential.created",
		"inbox",
		"Billing assistant (AI agent)",
	);
	await log(126, 9, "user_jonas", "contacts.imported", "contacts", "240 contacts");
	await log(124, 15, "user_jonas", "automation.created", "automation", "Trial onboarding");
	await log(124, 16, "user_jonas", "automation.created", "automation", "Upgrade to Pro");
	await log(110, 15, "user_sam", "smtp.created", "smtp", "SMTP credentials");
	await log(60, 10, "user_leo", "chat.created", "inbox", "Support chat");
	await log(33, 12, "user_leo", "suppression.added", "recipient", "chargeback@example.com");
	await log(30, 10, "user_jonas", "campaign.edited", "campaign", "Acme 3.0 launch");
	await log(
		21,
		16,
		"user_sam",
		"webhook.created",
		"webhook",
		"https://api.acme.example/hooks/mailroom",
	);
	await log(
		21,
		16,
		"user_sam",
		"webhook.created",
		"webhook",
		"https://hooks.acme.example/crm-sync",
	);
	await log(8, 16, "user_jonas", "automation.created", "automation", "Win back quiet customers");
	await log(6, 17, "user_priya", "template.created", "template", "Weekly summary");
	await log(3, 11, "user_maya", "member.invited", "member", "nina@agency.example");
	await log(
		0,
		2,
		"user_priya",
		"broadcast.review_requested",
		"broadcast",
		"November product update",
		draft?.id,
	);
}

function record(ip: string, count: number, from: string, pass: boolean) {
	const res = pass ? "pass" : "fail";
	return `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>${pass ? "none" : "quarantine"}</disposition><dkim>${res}</dkim><spf>${res}</spf></policy_evaluated></row><identifiers><header_from>${from}</header_from></identifiers><auth_results><dkim><domain>${pass ? from : "spoofed.example"}</domain><result>${res}</result><selector>demoaaa</selector></dkim><spf><domain>${pass ? `bounce.${from}` : "spoofed.example"}</domain><result>${res}</result></spf></auth_results></record>`;
}
