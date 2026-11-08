import { useRouter } from "@tanstack/react-router";
import { ListPlus, Newspaper, Plus, UserPlus, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { personActionFn, personActionOptionsFn } from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";

type Options = Awaited<ReturnType<typeof personActionOptionsFn>>;
type Action = Parameters<typeof personActionFn>[0]["data"]["action"];

/**
 * Marketing from a conversation: make whoever wrote in a contact, put them in a segment,
 * subscribe them to a newsletter or start an automation for them, without leaving the inbox.
 */
export function PersonActions({
	conversationId,
	isContact,
	inSegments,
	inNewsletters,
}: {
	conversationId: string;
	isContact: boolean;
	inSegments: string[];
	inNewsletters: string[];
}) {
	const router = useRouter();
	const [options, setOptions] = useState<Options | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async (action: Action, done: string) => {
		setBusy(true);
		try {
			const r = await personActionFn({ data: { conversation_id: conversationId, action } });
			if (action.type === "automation" && r.started === false)
				toast.info("They've already been through it (it doesn't let people in twice)");
			else toast.success(done);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	const empty = (what: string) => <DropdownMenuItem disabled>No {what} yet</DropdownMenuItem>;
	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (open && !options)
					personActionOptionsFn({ data: { conversation_id: conversationId } })
						.then(setOptions)
						.catch(async (e) => toast.error(await errorMessage(e)));
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					className="self-start"
				>
					{busy ? <Spinner /> : <Plus />}
					Add to…
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-60"
			>
				{!isContact && (
					<>
						<DropdownMenuItem
							onSelect={() => run({ type: "contact" }, "Added as a contact")}
						>
							<UserPlus />
							Contacts
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}
				{!options ? (
					<DropdownMenuLabel className="flex items-center gap-2 font-normal text-muted-foreground">
						<Spinner />
						Loading
					</DropdownMenuLabel>
				) : (
					<>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<ListPlus />A segment
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
								{options.segments.length
									? options.segments.map((s) => {
											const inIt = inSegments.includes(s.id);
											return (
												<DropdownMenuItem
													key={s.id}
													onSelect={() =>
														run(
															{
																type: "segment",
																segment_id: s.id,
																action: inIt ? "remove" : "add",
															},
															inIt
																? `Taken out of ${s.name}`
																: `Added to ${s.name}`,
														)
													}
												>
													<span className="min-w-0 flex-1 truncate">
														{s.name}
													</span>
													{inIt && (
														<span className="text-xs text-muted-foreground">
															Take out
														</span>
													)}
												</DropdownMenuItem>
											);
										})
									: empty("list segments")}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<Newspaper />A newsletter
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
								{options.newsletters.length
									? options.newsletters.map((n) => {
											const reads = inNewsletters.includes(n.id);
											return (
												<DropdownMenuItem
													key={n.id}
													onSelect={() =>
														run(
															{
																type: "newsletter",
																newsletter_id: n.id,
																action: reads
																	? "unsubscribe"
																	: "subscribe",
															},
															reads
																? `Unsubscribed from ${n.name}`
																: `Subscribed to ${n.name}`,
														)
													}
												>
													<span className="min-w-0 flex-1 truncate">
														{n.name}
													</span>
													{reads && (
														<span className="text-xs text-muted-foreground">
															Unsubscribe
														</span>
													)}
												</DropdownMenuItem>
											);
										})
									: empty("newsletters")}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<Workflow />
								An automation
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
								{options.automations.length
									? options.automations.map((x) => (
											<DropdownMenuItem
												key={x.id}
												onSelect={() =>
													run(
														{ type: "automation", automation_id: x.id },
														`Started ${x.name} for them`,
													)
												}
											>
												<span className="min-w-0 flex-1 truncate">
													{x.name}
												</span>
											</DropdownMenuItem>
										))
									: empty("automations turned on")}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
