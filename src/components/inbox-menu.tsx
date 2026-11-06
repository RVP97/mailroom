import { Link } from "@tanstack/react-router";
import {
	AtSign,
	Copy,
	MessageCircle,
	MessagesSquare,
	MoreHorizontal,
	Settings2,
	Trash2,
	Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { useCopy } from "@/components/copy";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Where an agent inbox's pages are: the same four from wherever you are. */
export type InboxPlace = "conversations" | "settings" | "workflow" | "chat";

/**
 * An agent inbox's "more" menu (the three dots): its other pages, copying its address and id,
 * and deleting it. Its pages are the inbox (settings, access, webhooks), its workflow, its website
 * chat and its conversations; the menu leaves out the one you're on.
 */
export function InboxMenu({
	inbox,
	here,
	onDelete,
	label = true,
	className,
}: {
	inbox: { id: string; name: string; address: string };
	here?: InboxPlace;
	/** Shown when given (the caller confirms). */
	onDelete?: () => void;
	/** Show the inbox's name over its items (off where the page already names it). */
	label?: boolean;
	className?: string;
}) {
	const { copy } = useCopy();
	const copied = (value: string) => {
		copy(value);
		toast.success("Copied");
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					aria-label={`More for ${inbox.name}`}
					className={className}
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="min-w-52"
			>
				{label && (
					<DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
						{inbox.name}
					</DropdownMenuLabel>
				)}
				{here !== "conversations" && (
					<DropdownMenuItem asChild>
						<Link
							to="/received"
							search={{ inbox: inbox.id }}
						>
							<MessagesSquare />
							Conversations
						</Link>
					</DropdownMenuItem>
				)}
				{here !== "settings" && (
					<DropdownMenuItem asChild>
						<Link
							to="/received/inboxes/$id"
							params={{ id: inbox.id }}
						>
							<Settings2 />
							Inbox settings
						</Link>
					</DropdownMenuItem>
				)}
				{here !== "workflow" && (
					<DropdownMenuItem asChild>
						<Link
							to="/received/workflow/$id"
							params={{ id: inbox.id }}
						>
							<Workflow />
							Workflow
						</Link>
					</DropdownMenuItem>
				)}
				{here !== "chat" && (
					<DropdownMenuItem asChild>
						<Link
							to="/received/chat/$id"
							params={{ id: inbox.id }}
						>
							<MessageCircle />
							Website chat
						</Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => copied(inbox.address)}>
					<AtSign />
					Copy address
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => copied(inbox.id)}>
					<Copy />
					Copy inbox id
				</DropdownMenuItem>
				{onDelete && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={onDelete}
						>
							<Trash2 />
							Delete inbox
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Links between an agent inbox's pages, under its header: the same row on the inbox, its
 * workflow and its website chat, so each is one click from the others.
 */
export function InboxPages({
	inbox,
	here,
	chat,
}: {
	inbox: { id: string };
	here: Exclude<InboxPlace, "conversations">;
	/** Whether its website chat is set up, and on (null: not set up). */
	chat?: { enabled: boolean } | null;
}) {
	const tab =
		"inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-1 text-sm whitespace-nowrap transition-colors [&_svg]:size-4";
	const off = `${tab} border-transparent text-muted-foreground hover:text-foreground`;
	const on = `${tab} border-foreground font-medium text-foreground`;
	return (
		<nav
			aria-label="Inbox pages"
			className="-mx-1 flex gap-5 overflow-x-auto border-b border-border/70 px-1"
		>
			<Link
				to="/received/inboxes/$id"
				params={{ id: inbox.id }}
				className={here === "settings" ? on : off}
				aria-current={here === "settings" ? "page" : undefined}
			>
				<Settings2 />
				Inbox
			</Link>
			<Link
				to="/received/workflow/$id"
				params={{ id: inbox.id }}
				className={here === "workflow" ? on : off}
				aria-current={here === "workflow" ? "page" : undefined}
			>
				<Workflow />
				Workflow
			</Link>
			<Link
				to="/received/chat/$id"
				params={{ id: inbox.id }}
				className={here === "chat" ? on : off}
				aria-current={here === "chat" ? "page" : undefined}
			>
				<MessageCircle />
				Website chat
				{chat !== undefined && (
					<span
						className={
							chat?.enabled
								? "size-1.5 rounded-full bg-emerald-500"
								: "size-1.5 rounded-full bg-muted-foreground/40"
						}
						title={chat ? (chat.enabled ? "On" : "Off") : "Not set up"}
					/>
				)}
			</Link>
			<Link
				to="/received"
				search={{ inbox: inbox.id }}
				className={off}
			>
				<MessagesSquare />
				Conversations
			</Link>
		</nav>
	);
}
