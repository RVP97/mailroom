import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { type ConversationData, ConversationPane } from "@/components/inbox/conversation-pane";
import { useInboxLive } from "@/components/inbox/use-inbox-live";
import { getConversationFn } from "@/functions/inboxes";
import { ago, listedRow, Sketch, useOpened, usePage } from "@/lib/sketch";

/** Standalone conversation route (mobile taps & direct deep links). */
export const Route = createFileRoute("/_app/received/$id")({
	loader: ({ params }) => getConversationFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [
			{ title: `${loaderData?.conversation.subject || "Conversation"} · Inbox · Mailroom` },
		],
	}),
	component: ConversationPage,
	pendingComponent: ConversationSketch,
});

function ConversationSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<ConversationData & { id: string }>("conversation-page", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<ConversationPage />
			</Sketch>
		);
	const listed = listedRow<{ subject: string; contact: string; last_message_at: string }>(
		"received",
		params.id,
	);
	const at = listed?.last_message_at ?? ago(30);
	const data: ConversationData = {
		conversation: {
			object: "conversation",
			id: params.id ?? "",
			brand_id: "",
			inbox_id: null,
			channel: "email",
			subject: listed?.subject ?? "Question about my booking",
			contact: listed?.contact ?? "guest@example.com",
			status: "open",
			unread: false,
			messages: 1,
			drafts: 0,
			snippet: null,
			last_message_at: at,
			last_inbound_at: at,
			last_reply_at: null,
			replied_by: null,
			resolved_at: null,
			created_at: at,
			assignee: null,
			tags: [],
			priority: "normal",
			snoozed_until: null,
			first_reply_at: null,
			sla: { reply_due_at: null, resolve_due_at: null, breached: [] },
			csat: null,
			held: false,
			held_at: null,
			has_more: false,
			before: null,
			timeline: [
				{
					type: "inbound",
					id: "sketch",
					at,
					unread: false,
					from: listed?.contact ?? "guest@example.com",
					to: ["support@example.com"],
					cc: [],
					reply_to: [],
					subject: listed?.subject ?? "Question",
					message_id: null,
					text: "Hello, I wanted to ask about my booking for next week.",
					new_text: "Hello, I wanted to ask about my booking for next week.",
					quoted: false,
					attachments: [],
					spam: false,
					verdicts: {
						spam: "PASS",
						virus: "PASS",
						spf: "PASS",
						dkim: "PASS",
						dmarc: "PASS",
					},
					flags: null,
					held: false,
				},
			],
		},
		compose: { from: null, to: [], subject: "", fixed_from: false },
		inbox: null,
		brand: null,
		activity: [],
		me: "",
		people: [],
		saved: [],
		articles: [],
		ai: { configured: false, copilot: false, auto_mode: "off" },
		variables: [],
		workflow: { tags: [], undo_seconds: 0, signature: false, sla: false },
		contact: null,
	};
	return (
		<Sketch data={data}>
			<ConversationPage />
		</Sketch>
	);
}

function ConversationPage() {
	const data = usePage(Route).data;
	const router = useRouter();
	const id = data.conversation.id;
	useOpened(
		"conversation-page",
		useMemo(() => ({ ...data, id, activity: [] }), [data, id]),
	);
	const { viewers, setTyping } = useInboxLive({
		viewing: id,
		onChange: (ev) => {
			if (!ev.conversation_id || ev.conversation_id === id) void router.invalidate();
		},
	});
	return (
		<ConversationPane
			data={data}
			viewers={viewers}
			onReload={() => router.invalidate()}
			onBack={() => void router.navigate({ to: "/received" })}
			onTypingChange={(on) => setTyping(id, on)}
		/>
	);
}
