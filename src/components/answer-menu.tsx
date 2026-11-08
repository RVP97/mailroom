import { useNavigate } from "@tanstack/react-router";
import { BookPlus, MessageSquarePlus, Sparkle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { answerToArticleFn, answerToSavedReplyFn } from "@/functions/workflow";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * Keep a good answer: one of the team's replies (or chat lines) as a draft help article or a
 * saved reply, in one click. Nothing shows for people who can do neither.
 */
export function AnswerMenu({ messageId, className }: { messageId: string; className?: string }) {
	const me = useMe();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	const canArticle = allows(me.active?.access, "help:edit");
	const canSaved = allows(me.active?.access, "inbox:reply");
	if (!canArticle && !canSaved) return null;
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			toast.error(await errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="icon-sm"
					variant="ghost"
					disabled={busy}
					className={cn("text-muted-foreground", className)}
					aria-label="Keep this answer"
					title="Keep this answer: a help article or a saved reply"
				>
					<Sparkle />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					Keep this answer
				</DropdownMenuLabel>
				{canArticle && (
					<DropdownMenuItem
						onSelect={() =>
							run(async () => {
								const a = await answerToArticleFn({
									data: { message_id: messageId },
								});
								toast.success("Draft article made: polish it and publish");
								await navigate({ to: "/articles/$id", params: { id: a.id } });
							})
						}
					>
						<BookPlus />
						Make a help article
					</DropdownMenuItem>
				)}
				{canSaved && (
					<DropdownMenuItem
						onSelect={() =>
							run(async () => {
								const r = await answerToSavedReplyFn({
									data: { message_id: messageId },
								});
								toast.success(`Saved reply “${r.name}” made`, {
									action: {
										label: "Edit",
										onClick: () => navigate({ to: "/received/replies" }),
									},
								});
							})
						}
					>
						<MessageSquarePlus />
						Save as a saved reply
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
