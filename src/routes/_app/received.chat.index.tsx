import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, MessageCircle } from "lucide-react";
import { InboxMenu } from "@/components/inbox-menu";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { listInboxesFn } from "@/functions/inboxes";
import { DEFAULT_INBOX_SETTINGS } from "@/lib/inbox-settings";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

/**
 * Website chat: each agent inbox can put a chat bubble on a website. This lists them with
 * whether each has one, and opens its settings (received.chat.$id.tsx).
 */
export const Route = createFileRoute("/_app/received/chat/")({
	loader: () => listInboxesFn(),
	head: () => ({ meta: [{ title: "Website chat · Mailroom" }] }),
	component: ChatsPage,
	pendingComponent: ChatsSketch,
});

type Data = Awaited<ReturnType<typeof listInboxesFn>>;

function ChatsSketch() {
	const data: Data = {
		brands: [],
		own: "",
		slugs: {},
		mailroomDomain: null,
		hosts: [],
		inboxes: sample(rememberedRows("chats", 1), (i) => ({
			object: "inbox",
			id: `sketch-${i}`,
			brand_id: "",
			name: "Support agent",
			address: "support@example.com",
			domain_id: null,
			reply_from: null,
			send_allow: [],
			send_block: [],
			description: null,
			settings: DEFAULT_INBOX_SETTINGS,
			created_at: "",
			updated_at: "",
			credentials: 1,
			last_used_at: null,
			open: 0,
			chat: null,
		})),
	};
	return (
		<Sketch data={data}>
			<ChatsPage />
		</Sketch>
	);
}

function ChatsPage() {
	const data = usePage(Route).data;
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:agents");
	useRememberRows("chats", data.inboxes.length);
	const names = new Map(data.brands.map((b) => [b.id, b.name]));
	return (
		<Page>
			<PageHeader
				title="Website chat"
				description="A chat bubble on your website. Each one belongs to an agent inbox: visitors chat live, and the team gets each chat by email and answers by replying, or from the inbox."
			/>
			<TableCard>
				{data.inboxes.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MessageCircle />
							</EmptyMedia>
							<EmptyTitle>Make an agent inbox first</EmptyTitle>
							<EmptyDescription>
								A website chat answers from an agent inbox, so its chats sit next to
								that inbox's email. Make one (support@ a receiving domain, or on the
								Mailroom address), then set up its chat here.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button asChild>
								<Link to="/received/inboxes">
									<Bot />
									Agent inboxes
								</Link>
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableBody>
							{data.inboxes.map((i) => (
								<TableRow
									key={i.id}
									className="relative"
								>
									<TableCell className="py-3">
										<Link
											to="/received/chat/$id"
											params={{ id: i.id }}
											className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
										>
											<Ph>{i.name}</Ph>
										</Link>
										<span className="mt-0.5 block truncate text-sm text-muted-foreground">
											<Ph>
												{i.chat?.origins.length
													? i.chat.origins.join(", ")
													: i.address}
												{names.size > 1 && names.get(i.brand_id)
													? ` · ${names.get(i.brand_id)}`
													: ""}
											</Ph>
										</span>
									</TableCell>
									<TableCell className="w-44 py-3 text-right text-sm">
										<span className="inline-flex items-center gap-2">
											{i.chat ? (
												<Badge variant="outline">
													<span
														className={
															i.chat.enabled
																? "size-1.5 rounded-full bg-emerald-500"
																: "size-1.5 rounded-full bg-muted-foreground/40"
														}
													/>
													{i.chat.enabled ? "On" : "Off"}
												</Badge>
											) : (
												<span className="text-muted-foreground">
													{canManage ? "Set up" : "Not set up"}
												</span>
											)}
										</span>
									</TableCell>
									<TableCell className="w-14 py-3 pr-3 text-right">
										<InboxMenu
											inbox={i}
											here="chat"
											className="relative z-10 size-8"
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Page>
	);
}
