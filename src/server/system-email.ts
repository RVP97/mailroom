import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { bareAddress, buildMime, encodeAddress, utf8Base64 } from "./aws/mime";
import { sendRaw } from "./aws/ses";
import { db, schema } from "./db";
import { aws, awsConfigured, cfg } from "./env";
import { orgContext, tenantSends } from "./org";
import { createEmails } from "./send";

/**
 * The platform's own emails (sign-in codes, invitations, alerts). They go first through
 * Cloudflare's Email Sending (the SYSTEM_EMAIL binding, from SYSTEM_FROM), so they don't depend on
 * SES or on any organization's tenant. If that's not set up or refuses, they go through SES from
 * SYSTEM_FROM_SES: when that address's domain belongs to an organization, like any other email of
 * it (its tenant, its logs), unless SES has paused that tenant; otherwise straight to SES. Without
 * either (local development) they're printed to the console.
 */
export async function sendSystemEmail(m: {
	to: string;
	subject: string;
	text: string;
	html: string;
}) {
	if (await sendThroughCloudflare(m)) return;
	const from = (cfg().SYSTEM_FROM_SES || cfg().SYSTEM_FROM)?.trim();
	if (!from || !awsConfigured()) {
		console.log(`[email to ${m.to}] ${m.subject}\n${m.text}`);
		return;
	}
	const host = bareAddress(from).split("@")[1]?.toLowerCase() ?? "";
	const owners = await db
		.select({ organization_id: schema.domains.organization_id, name: schema.domains.name })
		.from(schema.domains)
		.where(eq(schema.domains.status, "verified"));
	const owner = owners.find((d) => host === d.name || host.endsWith(`.${d.name}`));
	if (
		owner &&
		(await orgContext(owner.organization_id)).ready &&
		(await ownerSends(owner.organization_id))
	) {
		const [r] = await createEmails(
			owner.organization_id,
			[{ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }],
			{ source: "system", skipDns: true },
		);
		if (r?.error) throw r.error;
		return;
	}
	await sendRaw(aws(), {
		raw: utf8Base64(
			buildMime({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
		),
		from: encodeAddress(from),
		to: [m.to],
	});
}

interface CloudflareEmail {
	send(message: {
		from: { email: string; name?: string };
		to: string;
		subject: string;
		html: string;
		text: string;
	}): Promise<{ messageId: string }>;
}

/** Sends through Cloudflare's Email Sending; false when it isn't set up or refused the email. */
async function sendThroughCloudflare(m: {
	to: string;
	subject: string;
	text: string;
	html: string;
}) {
	const binding = (env as unknown as { SYSTEM_EMAIL?: CloudflareEmail }).SYSTEM_EMAIL;
	const from = cfg().SYSTEM_FROM?.trim();
	if (!binding || !from) return false;
	const name = from.includes("<")
		? from.slice(0, from.indexOf("<")).trim().replace(/^"|"$/g, "")
		: "";
	try {
		await binding.send({
			from: { email: bareAddress(from), ...(name ? { name } : {}) },
			to: m.to,
			subject: m.subject,
			html: m.html,
			text: m.text,
		});
		return true;
	} catch (error) {
		console.error("system-email: Cloudflare didn't send it, trying SES", error);
		return false;
	}
}

/** Whether SES still sends for the organization's tenant, as last read. */
async function ownerSends(organizationId: string) {
	const row = await db
		.select({ status: schema.orgSending.tenant_status })
		.from(schema.orgSending)
		.where(eq(schema.orgSending.organization_id, organizationId))
		.get();
	return tenantSends(row?.status);
}

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
	);

/** A plain, well-behaved layout for the platform's emails. */
export function systemLayout(o: {
	title: string;
	lines: string[];
	code?: string;
	button?: { label: string; url: string };
}) {
	const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1a">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e7e6e1;border-radius:12px"><tr><td style="padding:32px">
<p style="margin:0 0 24px;font-size:15px;font-weight:600;letter-spacing:-.01em">Mailroom</p>
<h1 style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(o.title)}</h1>
${o.lines.map((l) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#4a4a46">${escapeHtml(l)}</p>`).join("")}
${o.code ? `<p style="margin:20px 0;font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:.3em">${escapeHtml(o.code)}</p>` : ""}
${o.button ? `<p style="margin:24px 0 8px"><a href="${escapeHtml(o.button.url)}" style="display:inline-block;background:#1c1c1a;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px">${escapeHtml(o.button.label)}</a></p>` : ""}
</td></tr></table></body></html>`;
	const text = [
		o.title,
		"",
		...o.lines,
		...(o.code ? ["", o.code] : []),
		...(o.button ? ["", `${o.button.label}: ${o.button.url}`] : []),
	].join("\n");
	return { html, text };
}
