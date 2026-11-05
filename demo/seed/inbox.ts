/**
 * Acme's support: email arriving the way SES delivers it (an S3 object and a notification, read by
 * the app's receiveSes), the team answering from the dashboard, an AI agent with its own
 * credential drafting and answering billing questions through the API, and the website chat.
 */

import { eq } from "drizzle-orm";
import { brandIds } from "@/server/brands";
import {
	saveChatWidget,
	startChat,
	teamSays,
	visitorChat,
	visitorSays,
	widgetByKey,
} from "@/server/chat";
import { sendReply, updateConversation } from "@/server/conversations";
import { db, schema } from "@/server/db";
import { receiveSes } from "@/server/inbound";
import { createRule } from "@/server/inbound-rules";
import { sender } from "@/server/inbox-api";
import { createCredential, createInbox, memberActor } from "@/server/inboxes";
import { at } from "../clock";
import { putInDropBox } from "../outside";
import { flushSes } from "../ses";
import { runDispatcher, settle } from "../shims/cloudflare-workers";
import { api } from "./api";
import { ORG } from "./ids";
import { type Ctx, DAY, HOUR } from "./setup";

const MIN = 60_000;
let n = 0;

/** A message as it reaches SES: plain text, maybe a reply, maybe a file. */
function mime(m: {
	from: string;
	to: string;
	subject: string;
	text: string;
	inReplyTo?: string | null;
	file?: { name: string; type: string; base64: string };
}) {
	const id = `<demo-${++n}-${Date.now().toString(36)}@${m.from.split("@")[1]?.replace(/>$/, "")}>`;
	const head = [
		`From: ${m.from}`,
		`To: ${m.to}`,
		`Subject: ${m.subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: ${id}`,
		...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
		"MIME-Version: 1.0",
	];
	if (!m.file)
		return {
			id,
			raw: [...head, "Content-Type: text/plain; charset=UTF-8", "", m.text, ""].join("\r\n"),
		};
	const b = `b${n}`;
	return {
		id,
		raw: [
			...head,
			`Content-Type: multipart/mixed; boundary="${b}"`,
			"",
			`--${b}`,
			"Content-Type: text/plain; charset=UTF-8",
			"",
			m.text,
			`--${b}`,
			`Content-Type: ${m.file.type}; name="${m.file.name}"`,
			`Content-Disposition: attachment; filename="${m.file.name}"`,
			"Content-Transfer-Encoding: base64",
			"",
			m.file.base64,
			`--${b}--`,
			"",
		].join("\r\n"),
	};
}

/** SES receives it: the object in the drop box, then the notification to the app. */
async function arrives(m: Parameters<typeof mime>[0]) {
	const { id, raw } = mime(m);
	const key = `inbound/demo-${n}`;
	putInDropBox(key, raw);
	const bare = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).toLowerCase();
	const pass = { status: "PASS" };
	await receiveSes({
		notificationType: "Received",
		mail: {
			messageId: `demo-in-${n}`,
			timestamp: new Date().toISOString(),
			source: bare(m.from),
			destination: [bare(m.to)],
			commonHeaders: { from: [m.from], to: [m.to], subject: m.subject, messageId: id },
		},
		receipt: {
			timestamp: new Date().toISOString(),
			recipients: [bare(m.to)],
			spamVerdict: pass,
			virusVerdict: pass,
			spfVerdict: pass,
			dkimVerdict: pass,
			dmarcVerdict: pass,
			action: {
				type: "S3",
				bucketName: "mailroom-inbound-123456789012-us-east-1",
				objectKey: key,
			},
		},
	});
	await settle();
	return id;
}

/** A tiny PNG (a screenshot stand-in). */
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAAA35e4mAAAAZklEQVR4nO3PQQ0AIBDAMMC/5+ONAvZoFSzZnplZ/+3ngQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8BgQ8B4QBcEQNNaZL7NQAAAABJRU5ErkJggg==";

export async function inbox(ctx: Ctx) {
	const brands = await brandIds(ORG);
	const person = (id: string, name: string) =>
		memberActor({
			organizationId: ORG,
			brands,
			userId: id,
			name,
			canReply: true,
			masked: false,
		});
	const leo = person("user_leo", "Leo Martins");
	const maya = person("user_maya", "Maya Chen");
	const dashboard = sender({ source: "dashboard" });
	const step = async (t: number, fn: () => Promise<unknown>) => {
		await flushSes(t);
		await at(t, async () => {
			await fn();
			await runDispatcher();
		});
		await settle();
	};
	const convOf = async (messageId: string) =>
		(
			await db
				.select({ c: schema.receivedEmails.conversation_id })
				.from(schema.receivedEmails)
				.where(eq(schema.receivedEmails.message_id, messageId.replace(/^<|>$/g, "")))
				.get()
		)?.c ??
		(
			await db
				.select({ c: schema.receivedEmails.conversation_id })
				.from(schema.receivedEmails)
				.where(eq(schema.receivedEmails.message_id, messageId))
				.get()
		)?.c;

	let support = "";
	let billing = "";
	let agentToken = "";
	await step(ctx.ago(140, 11), async () => {
		support = (
			await createInbox(
				ORG,
				{
					name: "Support",
					local_part: "support",
					domain: "acme.example",
					description: "Customers' questions, answered by the support team.",
				},
				{ userId: "user_leo" },
			)
		).id;
		billing = (
			await createInbox(
				ORG,
				{
					name: "Billing",
					local_part: "billing",
					domain: "acme.example",
					description: "Invoices and plan changes. The billing assistant answers first.",
				},
				{ userId: "user_sam" },
			)
		).id;
		const b = await db
			.select()
			.from(schema.inboxes)
			.where(eq(schema.inboxes.id, billing))
			.get();
		if (!b) throw new Error("no billing inbox");
		agentToken = (
			await createCredential(
				b,
				{
					name: "Billing assistant (AI agent)",
					permissions: ["read", "attachments", "triage", "draft", "send"],
					send_scope: "replies",
				},
				{ userId: "user_sam" },
			)
		).token;
		await createCredential(
			b,
			{ name: "Read-only reporting", permissions: ["read"] },
			{ userId: "user_sam" },
		);
		await createRule(ORG, {
			name: "Invoices from vendors go to accounting",
			match_to: "invoices@acme.example",
			action: "forward",
			forward_to: ["accounting@example.com"],
		});
		await createRule(ORG, {
			name: "Drop out-of-office replies",
			match_subject: "Automatic reply",
			action: "drop",
		});
	});

	const customer = (name: string, email: string) => `${name} <${email}>`;

	// 1. A how-to question, answered and resolved.
	{
		const t = ctx.ago(12, 9);
		let id = "";
		await step(t, async () => {
			id = await arrives({
				from: customer("Hana Sato", "hana.sato@gmail.com"),
				to: "support@acme.example",
				subject: "Where did the export button go?",
				text: "Hi! Since the 3.0 update I can't find how to export a board to CSV. Did it move?\n\nThanks,\nHana",
			});
		});
		await step(t + 38 * MIN, async () => {
			const c = await convOf(id);
			if (c)
				await sendReply(
					leo,
					c,
					{
						text: "Hi Hana,\n\nIt moved into the board's ⋯ menu, under Export. CSV and PDF are both there, and you can pick which columns go in.\n\nLeo, Acme support",
					},
					dashboard,
				);
		});
		await step(t + 3 * HOUR, async () => {
			id = await arrives({
				from: customer("Hana Sato", "hana.sato@gmail.com"),
				to: "support@acme.example",
				subject: "Re: Where did the export button go?",
				text: "Found it, thank you!",
				inReplyTo: id,
			});
			const c = await convOf(id);
			if (c) await updateConversation(leo, c, { status: "resolved" });
		});
	}
	// 2. A bug report with a screenshot, waiting on the team.
	await step(ctx.ago(1, 15), async () => {
		await arrives({
			from: customer("Omar Haddad", "omar@northwind.example"),
			to: "support@acme.example",
			subject: "Calendar view shows tasks a day early",
			text: "Hello,\n\nIn the calendar view, every task due on a Monday shows on Sunday. We're in Berlin (UTC+1). Screenshot attached.\n\nOmar Haddad\nNorthwind",
			file: { name: "calendar.png", type: "image/png", base64: PNG },
		});
	});
	// 3. A feature request, still unread.
	await step(ctx.ago(0, 1) - 3 * HOUR, async () => {
		await arrives({
			from: customer("Rosa Lopez", "rosa.lopez@outlook.com"),
			to: "support@acme.example",
			subject: "Gantt chart?",
			text: "Any plans for a Gantt chart view? It's the one thing our PMO keeps asking for.\n\nRosa",
		});
	});
	// 4. A back-and-forth with Maya about seats.
	{
		const t = ctx.ago(3, 10);
		let id = "";
		await step(t, async () => {
			id = await arrives({
				from: customer("Daniel Kim", "daniel@hooli.example"),
				to: "support@acme.example",
				subject: "Adding 12 seats mid-month",
				text: "We're onboarding a new team of 12 next week. If we add the seats now, are we charged for the full month?\n\nDaniel",
			});
		});
		await step(t + 2 * HOUR, async () => {
			const c = await convOf(id);
			if (c)
				await sendReply(
					maya,
					c,
					{
						text: "Hi Daniel,\n\nNo: seats added mid-month are prorated to the day, and they show on your next invoice as a separate line. If you'd like, I can add them for you now and you can invite people whenever they're ready.\n\nMaya, Customer success",
					},
					dashboard,
				);
		});
		await step(t + 20 * HOUR, async () => {
			await arrives({
				from: customer("Daniel Kim", "daniel@hooli.example"),
				to: "support@acme.example",
				subject: "Re: Adding 12 seats mid-month",
				text: "That would be great, please go ahead. Can the invoice say 'Hooli Platform team' on it?",
				inReplyTo: id,
			});
		});
	}

	// The billing inbox: the agent answers through the API with its own credential.
	const agent = (method: string, path: string, body?: unknown) =>
		api(agentToken, method, path, body, { agent: 3 });
	{
		const t = ctx.ago(9, 13);
		let id = "";
		await step(t, async () => {
			id = await arrives({
				from: customer("Elena Rossi", "elena.rossi@gmail.com"),
				to: "billing@acme.example",
				subject: "Need our VAT number on invoices",
				text: "Hi, could you add our VAT number IT01234567890 to the October invoice and future ones? Thanks, Elena",
			});
		});
		await step(t + 2 * MIN, async () => {
			const c = await convOf(id);
			if (!c) return;
			await agent("POST", `/conversations/${c}/reply`, {
				text: "Hi Elena,\n\nDone: your VAT number is on the October invoice (re-issued, same number) and will be on every invoice from now on. You can download it from Settings › Billing.\n\nThe Acme billing assistant",
			});
			await agent("PATCH", `/conversations/${c}`, { status: "resolved" });
		});
	}
	{
		const t = ctx.ago(0, 1) - 5 * HOUR;
		let id = "";
		await step(t, async () => {
			id = await arrives({
				from: customer("Victor Novak", "victor@vandelay.example"),
				to: "billing@acme.example",
				subject: "Refund for a duplicate charge",
				text: "We were charged twice for November ($96.00 each). Can you refund one of them?\n\nVictor Novak, Vandelay",
			});
		});
		// A refund is the team's call: the agent leaves a draft for a person to send.
		await step(t + 3 * MIN, async () => {
			const c = await convOf(id);
			if (c)
				await agent("POST", `/conversations/${c}/drafts`, {
					text: "Hi Victor,\n\nSorry about that: I can see two charges of $96.00 on November 1. I've refunded the second one; it should be back on your card in 5 to 10 days.\n\nThe Acme billing assistant",
				});
		});
	}

	// The website chat.
	const box = await db.select().from(schema.inboxes).where(eq(schema.inboxes.id, support)).get();
	if (!box) return;
	let key = "";
	await step(ctx.ago(60, 10), async () => {
		const w = await saveChatWidget(
			box,
			{
				enabled: true,
				origins: ["acme.example", "*.acme.example"],
				ask_email: "optional",
				notify: ["leo@acme.example"],
				design: {
					title: "Acme support",
					subtitle: "We usually reply in a few minutes",
					greeting: "Hi! Ask us anything about Acme.",
					color: "#4f46e5",
				},
			},
			{ userId: "user_leo" },
		);
		key =
			(w as { public_key?: string }).public_key ??
			(
				await db
					.select()
					.from(schema.chatWidgets)
					.where(eq(schema.chatWidgets.inbox_id, support))
					.get()
			)?.public_key ??
			"";
	});
	const chat = async (
		t: number,
		lines: [who: "v" | "t", text: string, after: number][],
		o: { name?: string; email?: string; resolve?: boolean } = {},
	) => {
		let token = "";
		let conversation = "";
		await step(t, async () => {
			const w = await widgetByKey(key);
			if (!w) throw new Error("no chat widget");
			const first = lines.shift() as [string, string, number];
			const s = await startChat(
				w,
				{
					text: first[1],
					name: o.name,
					email: o.email,
					page: "https://acme.example/pricing",
				},
				{ ip: "198.51.100.20" },
			);
			token = s.token;
			conversation = s.conversation.id;
		});
		let time = t;
		for (const [who, text, after] of lines) {
			time += after * MIN;
			await step(time, async () => {
				if (who === "v") {
					const c = await visitorChat(key, token);
					if (c) await visitorSays(c, { text });
				} else {
					const x = await db
						.select()
						.from(schema.conversations)
						.where(eq(schema.conversations.id, conversation))
						.get();
					if (x) await teamSays(leo, x, { text, via: "dashboard" });
				}
			});
		}
		if (o.resolve)
			await step(time + 10 * MIN, () =>
				updateConversation(leo, conversation, { status: "resolved" }),
			);
	};
	await chat(
		ctx.ago(6, 14),
		[
			["v", "Hi, does the Team plan include SSO?", 0],
			["t", "Hi! Yes, SAML SSO is on the Team plan, with SCIM for user provisioning.", 2],
			["v", "Perfect, and can we try it before buying?", 1],
			["t", "Of course: start a trial and write to us, we'll turn SSO on for it.", 1],
			["v", "Great, thanks!", 1],
		],
		{ name: "Priya", resolve: true },
	);
	await chat(
		ctx.ago(0, 1) - 40 * MIN,
		[
			["v", "Hello, is there a discount for nonprofits?", 0],
			["t", "Hi! There is: 50% off any plan. Could you tell me your organization's name?", 3],
			["v", "Sure, it's Open Shelter, we run food banks in three cities.", 2],
		],
		{ name: "Sam", email: "sam@openshelter.example" },
	);
	await chat(ctx.ago(2, 20), [["v", "Can I move a project from one workspace to another?", 0]], {
		email: "ines.costa@icloud.com",
	});
	void DAY;
}
