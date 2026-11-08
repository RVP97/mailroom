import { Link, useRouter } from "@tanstack/react-router";
import { AlarmClock, Check, MessagesSquare, StickyNote, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DateTimePicker } from "@/components/date-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { deleteContactNoteFn, saveContactNoteFn } from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface NoteItem {
	id: string;
	kind: "note" | "follow_up";
	text: string;
	author: string;
	author_id: string | null;
	due_at: string | null;
	overdue: boolean;
	assignee_id: string | null;
	assignee: string | null;
	done_at: string | null;
	done_by: string | null;
	created_at: string;
}

export interface NotesData {
	follow_ups: NoteItem[];
	notes: NoteItem[];
	conversation_notes: {
		id: string;
		text: string;
		author: string;
		created_at: string;
		conversation_id: string;
		subject: string;
	}[];
}

/** Tomorrow at 9:00, local, as the picker wants it. */
function tomorrowNine() {
	const d = new Date(Date.now() + 86_400_000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

/** A contact's notes and follow-ups, with the notes from its conversations in the inbox. */
export function ContactNotesCard({
	notes,
	brand,
	contactId,
	canNote,
	me,
	team,
}: {
	notes: NotesData;
	brand: string;
	contactId: string;
	canNote: boolean;
	me: string;
	team: { id: string; name: string }[];
}) {
	const router = useRouter();
	const [text, setText] = useState("");
	const [follow, setFollow] = useState(false);
	const [due, setDue] = useState(tomorrowNine);
	const [who, setWho] = useState(me);
	const [busy, setBusy] = useState(false);

	const save = async (data: Parameters<typeof saveContactNoteFn>[0]["data"], done?: string) => {
		setBusy(true);
		try {
			await saveContactNoteFn({ data });
			await router.invalidate();
			if (done) toast.success(done);
			return true;
		} catch (e) {
			toast.error(errorMessage(e));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const add = async () => {
		const ok = await save(
			{
				brand,
				contact_id: contactId,
				text,
				due_at: follow ? new Date(due).toISOString() : null,
				assignee_id: follow ? who : null,
			},
			follow ? "Follow-up set" : "Note added",
		);
		if (ok) {
			setText("");
			setFollow(false);
			setDue(tomorrowNine());
		}
	};
	const remove = async (id: string) => {
		try {
			await deleteContactNoteFn({ data: { brand, id } });
			await router.invalidate();
			toast.success("Note deleted");
		} catch (e) {
			toast.error(errorMessage(e));
		}
	};

	const timeline = [
		...notes.notes.map((x) => ({ type: "own" as const, at: x.created_at, x })),
		...notes.conversation_notes.map((x) => ({ type: "inbox" as const, at: x.created_at, x })),
	].sort((a, b) => b.at.localeCompare(a.at));

	return (
		<Card className="gap-4 p-5">
			<div className="flex items-center justify-between gap-2">
				<h2 className="font-semibold">Notes &amp; follow-ups</h2>
				{notes.follow_ups.length > 0 && (
					<span className="text-xs text-muted-foreground">
						{notes.follow_ups.length} open
					</span>
				)}
			</div>

			{canNote && (
				<div className="flex flex-col gap-3">
					<Textarea
						aria-label="New note"
						placeholder="Write a note for the team…"
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={3}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) add();
						}}
					/>
					<div className="flex items-center gap-2.5 text-sm">
						<Switch
							id="note-follow"
							checked={follow}
							onCheckedChange={setFollow}
						/>
						<label htmlFor="note-follow">Remind someone to follow up</label>
					</div>
					{follow && (
						<div className="flex flex-col gap-2">
							<DateTimePicker
								id="note-due"
								value={due}
								onChange={setDue}
							/>
							<Select
								value={who}
								onValueChange={setWho}
							>
								<SelectTrigger
									aria-label="Who follows up"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{team.map((m) => (
										<SelectItem
											key={m.id}
											value={m.id}
										>
											{m.id === me ? `${m.name} (you)` : m.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
					<div>
						<Button
							size="sm"
							disabled={busy || !text.trim()}
							onClick={add}
						>
							{follow ? "Set follow-up" : "Add note"}
						</Button>
					</div>
				</div>
			)}

			{notes.follow_ups.length > 0 && (
				<ul className="flex flex-col gap-2">
					{notes.follow_ups.map((f) => (
						<li
							key={f.id}
							className={cn(
								"flex items-start gap-3 rounded-lg border p-3 text-sm",
								f.overdue && "border-red-500/40 bg-red-500/5",
							)}
						>
							<AlarmClock
								className={cn(
									"mt-0.5 size-4 shrink-0",
									f.overdue ? "text-red-600" : "text-amber-600",
								)}
							/>
							<div className="min-w-0 flex-1">
								<p className="whitespace-pre-wrap break-words">{f.text}</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{f.overdue ? "Overdue, was due " : "Due "}
									{formatRelative(f.due_at)}
									{f.assignee
										? ` · ${f.assignee_id === me ? "You" : f.assignee}`
										: ""}
									{` · from ${f.author}`}
								</p>
							</div>
							{canNote && (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										save(
											{ brand, contact_id: contactId, id: f.id, done: true },
											"Done",
										)
									}
								>
									<Check />
									Done
								</Button>
							)}
						</li>
					))}
				</ul>
			)}

			{timeline.length === 0 && notes.follow_ups.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No notes yet. Notes left on this person's conversations show here too.
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{timeline.map((t) =>
						t.type === "own" ? (
							<li
								key={t.x.id}
								className="group flex items-start gap-3 text-sm"
							>
								{t.x.kind === "follow_up" ? (
									<Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
								) : (
									<StickyNote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								)}
								<div className="min-w-0 flex-1">
									<p
										className={cn(
											"whitespace-pre-wrap break-words",
											t.x.kind === "follow_up" &&
												"text-muted-foreground line-through",
										)}
									>
										{t.x.text}
									</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{t.x.author} · {formatAgo(t.x.created_at)}
										{t.x.done_at
											? ` · done by ${t.x.done_by ?? "someone"}`
											: ""}
									</p>
								</div>
								{canNote && (
									<div className="flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
										{t.x.kind === "follow_up" && (
											<Button
												size="icon"
												variant="ghost"
												className="size-7"
												aria-label="Not done yet"
												onClick={() =>
													save({
														brand,
														contact_id: contactId,
														id: t.x.id,
														done: false,
													})
												}
											>
												<Undo2 />
											</Button>
										)}
										<Button
											size="icon"
											variant="ghost"
											className="size-7"
											aria-label="Delete the note"
											onClick={() => remove(t.x.id)}
										>
											<Trash2 />
										</Button>
									</div>
								)}
							</li>
						) : (
							<li
								key={t.x.id}
								className="flex items-start gap-3 text-sm"
							>
								<MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="whitespace-pre-wrap break-words">{t.x.text}</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{t.x.author} · {formatAgo(t.x.created_at)} · on{" "}
										<Link
											to="/received/$id"
											params={{ id: t.x.conversation_id }}
											className="underline underline-offset-2 hover:text-foreground"
										>
											{t.x.subject}
										</Link>
									</p>
								</div>
							</li>
						),
					)}
				</ul>
			)}
		</Card>
	);
}
