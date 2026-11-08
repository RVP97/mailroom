import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { LEVEL } from "@/components/engagement";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { SegmentCondition, SegmentRules } from "@/server/live-segments";

/** What the brand's rules can pick from (segmentOptionsFn). */
export type RuleOptions = {
	events: { name: string; count: number }[];
	forms: { id: string; name: string }[];
	topics: { id: string; name: string }[];
	properties: { key: string; type: string }[];
	segments: { id: string; name: string }[];
	polls: {
		broadcast_id: string;
		broadcast: string;
		poll_id: string;
		question: string;
		options: string[];
	}[];
	surveys?: { id: string; name: string; kind: string; options: string[] }[];
};

type Type = SegmentCondition["type"];
type SurveyAnswer = Extract<SegmentCondition, { type: "survey" }>["answer"];

/** The kinds of rule, grouped the way people think about them. */
const KINDS: { group: string; items: [Type, string][] }[] = [
	{
		group: "About them",
		items: [
			["property", "A property"],
			["email", "Their email address"],
			["subscribed", "Subscribed or not"],
			["source", "Where they came from"],
			["joined", "When they joined"],
			["topic", "A topic"],
			["segment", "Another segment"],
		],
	},
	{
		group: "With your email",
		items: [
			["engagement", "How engaged they are"],
			["lead_score", "Their lead score"],
			["email_activity", "Got, opened or clicked"],
			["poll", "Answered a poll"],
			["survey", "Answered a survey"],
			["referrals", "Friends they brought"],
		],
	},
	{
		group: "In your app and support",
		items: [
			["event", "Did something in your app"],
			["conversation", "Wrote in"],
			["rating", "Their support rating"],
			["chatted", "Chatted on the website"],
		],
	},
];

/** A new rule of a kind, filled in with sensible starting values. */
export function newCondition(type: Type, o: RuleOptions): SegmentCondition {
	switch (type) {
		case "property":
			return { type, key: o.properties[0]?.key ?? "plan", op: "is", value: "" };
		case "email":
			return { type, op: "ends_with", value: "" };
		case "subscribed":
			return { type, value: true };
		case "source":
			return { type, value: "form" };
		case "joined":
			return { type, op: "within", days: 30 };
		case "topic":
			return { type, topic_id: o.topics[0]?.id ?? "", value: "opt_in" };
		case "segment":
			return { type, segment_id: o.segments[0]?.id ?? "", value: true };
		case "engagement":
			return { type, levels: ["champion", "engaged"] };
		case "email_activity":
			return { type, action: "opened", did: true, days: 30 };
		case "event":
			return { type, name: o.events[0]?.name ?? "", did: true, days: 30 };
		case "poll": {
			const p = o.polls[0];
			return { type, broadcast_id: p?.broadcast_id ?? "", poll_id: p?.poll_id, answer: 0 };
		}
		case "referrals":
			return { type, min: 1 };
		case "conversation":
			return { type, status: "any", did: true, days: 30 };
		case "rating":
			return { type, op: "at_most", value: 2, days: 90 };
		case "chatted":
			return { type, page: "", days: 30 };
		case "lead_score":
			return { type, op: "hot" };
		case "survey": {
			const s = o.surveys?.[0];
			return {
				type,
				survey_id: s?.id ?? "",
				answer: s?.kind === "nps" ? "promoter" : s?.kind === "choice" ? "choice" : "any",
				...(s?.kind === "choice" ? { value: 0 } : {}),
				days: 90,
			};
		}
	}
}

function Pick<T extends string>({
	value,
	onChange,
	items,
	className,
	placeholder,
	label,
}: {
	value: T | "";
	onChange: (v: T) => void;
	items: [T, string][];
	className?: string;
	placeholder?: string;
	label: string;
}) {
	return (
		<Select
			value={value || undefined}
			onValueChange={(v) => onChange(v as T)}
		>
			<SelectTrigger
				aria-label={label}
				className={cn("min-w-0", className)}
			>
				<SelectValue placeholder={placeholder ?? "Pick…"} />
			</SelectTrigger>
			<SelectContent>
				{items.map(([v, l]) => (
					<SelectItem
						key={v}
						value={v}
					>
						{l}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function Num({
	value,
	onChange,
	label,
	min = 1,
	max = 3650,
	className,
}: {
	value: number | undefined;
	onChange: (v: number | undefined) => void;
	label: string;
	min?: number;
	max?: number;
	className?: string;
}) {
	return (
		<Input
			aria-label={label}
			inputMode="numeric"
			className={cn("h-8 w-16 text-center tabular-nums", className)}
			value={value ?? ""}
			onChange={(e) => {
				const n = Number.parseInt(e.target.value.replace(/\D/g, ""), 10);
				onChange(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined);
			}}
		/>
	);
}

const Words = ({ children }: { children: ReactNode }) => (
	<span className="text-sm text-muted-foreground">{children}</span>
);

const SOURCES: [string, string][] = [
	["form", "Any sign-up form"],
	["referral", "A friend's link"],
	["import", "An imported file"],
	["api", "Your app (the API)"],
	["dashboard", "The dashboard"],
	["automation", "An automation"],
	["event", "An event from your app"],
];

/** The fields of one rule, as a sentence. */
function Fields({
	c,
	set,
	o,
}: {
	c: SegmentCondition;
	set: (c: SegmentCondition) => void;
	o: RuleOptions;
}) {
	switch (c.type) {
		case "property":
			return (
				<>
					<Pick
						label="Property"
						value={c.key}
						onChange={(key) => set({ ...c, key })}
						items={o.properties.map((p) => [p.key, p.key])}
						placeholder="Property"
						className="w-32 font-mono text-[13px]"
					/>
					<Pick
						label="Comparison"
						value={c.op}
						onChange={(op) => set({ ...c, op })}
						items={[
							["is", "is"],
							["is_not", "isn't"],
							["contains", "contains"],
							["gt", "is more than"],
							["lt", "is less than"],
							["set", "has a value"],
							["not_set", "is empty"],
						]}
						className="w-32"
					/>
					{c.op !== "set" && c.op !== "not_set" && (
						<Input
							aria-label="Value"
							className="h-8 w-36"
							value={c.value ?? ""}
							onChange={(e) => set({ ...c, value: e.target.value })}
						/>
					)}
				</>
			);
		case "email":
			return (
				<>
					<Pick
						label="Comparison"
						value={c.op}
						onChange={(op) => set({ ...c, op })}
						items={[
							["ends_with", "ends with"],
							["contains", "contains"],
						]}
						className="w-32"
					/>
					<Input
						aria-label="Text"
						placeholder="@gmail.com"
						className="h-8 w-40"
						value={c.value}
						onChange={(e) => set({ ...c, value: e.target.value })}
					/>
				</>
			);
		case "subscribed":
			return (
				<Pick
					label="Subscribed"
					value={c.value ? "yes" : "no"}
					onChange={(v) => set({ ...c, value: v === "yes" })}
					items={[
						["yes", "gets your broadcasts"],
						["no", "unsubscribed from all"],
					]}
					className="w-52"
				/>
			);
		case "source":
			return (
				<Pick
					label="Where from"
					value={c.value}
					onChange={(value) => set({ ...c, value })}
					items={[
						...SOURCES.slice(0, 1),
						...o.forms.map((f): [string, string] => [
							`form:${f.id}`,
							`The form ${f.name}`,
						]),
						...SOURCES.slice(1),
					]}
					className="w-56"
				/>
			);
		case "joined":
			return (
				<>
					<Pick
						label="When"
						value={c.op}
						onChange={(op) => set({ ...c, op })}
						items={[
							["within", "in the last"],
							["before", "more than"],
						]}
						className="w-32"
					/>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days: days ?? 1 })}
					/>
					<Words>{c.op === "within" ? "days" : "days ago"}</Words>
				</>
			);
		case "topic":
			return (
				<>
					<Pick
						label="Topic"
						value={c.topic_id}
						onChange={(topic_id) => set({ ...c, topic_id })}
						items={o.topics.map((t) => [t.id, t.name])}
						placeholder="Topic"
						className="w-40"
					/>
					<Pick
						label="Choice"
						value={c.value}
						onChange={(value) => set({ ...c, value })}
						items={[
							["opt_in", "gets it"],
							["opt_out", "left it"],
						]}
						className="w-28"
					/>
				</>
			);
		case "segment":
			return (
				<>
					<Pick
						label="In or not"
						value={c.value ? "in" : "out"}
						onChange={(v) => set({ ...c, value: v === "in" })}
						items={[
							["in", "is in"],
							["out", "isn't in"],
						]}
						className="w-28"
					/>
					<Pick
						label="Segment"
						value={c.segment_id}
						onChange={(segment_id) => set({ ...c, segment_id })}
						items={o.segments.map((s) => [s.id, s.name])}
						placeholder="Segment"
						className="w-40"
					/>
				</>
			);
		case "engagement":
			return (
				<ToggleGroup
					type="multiple"
					variant="outline"
					size="sm"
					value={c.levels}
					onValueChange={(levels) =>
						levels.length && set({ ...c, levels: levels as typeof c.levels })
					}
					className="flex-wrap"
				>
					{(["champion", "engaged", "cooling", "cold", "new"] as const).map((l) => (
						<ToggleGroupItem
							key={l}
							value={l}
							className="px-2.5"
						>
							{LEVEL[l].label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			);
		case "email_activity":
			return (
				<>
					<Pick
						label="Did or didn't"
						value={c.did ? "did" : "didnt"}
						onChange={(v) => set({ ...c, did: v === "did" })}
						items={[
							["did", "did"],
							["didnt", "didn't"],
						]}
						className="w-24"
					/>
					<Pick
						label="What"
						value={c.action}
						onChange={(action) => set({ ...c, action })}
						items={[
							["received", "get an email"],
							["opened", "open an email"],
							["clicked", "click in an email"],
						]}
						className="w-40"
					/>
					{c.did && (
						<>
							<Words>at least</Words>
							<Num
								label="Times"
								value={c.min ?? 1}
								onChange={(min) => set({ ...c, min })}
								max={1000}
							/>
							<Words>{(c.min ?? 1) === 1 ? "time" : "times"}</Words>
						</>
					)}
					<Words>in the last</Words>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days: days ?? 1 })}
					/>
					<Words>days</Words>
				</>
			);
		case "event":
			return (
				<>
					<Pick
						label="Did or didn't"
						value={c.did ? "did" : "didnt"}
						onChange={(v) => set({ ...c, did: v === "did" })}
						items={[
							["did", "did"],
							["didnt", "didn't do"],
						]}
						className="w-28"
					/>
					{o.events.length ? (
						<Pick
							label="Event"
							value={c.name}
							onChange={(name) => set({ ...c, name })}
							items={o.events.map((e) => [e.name, e.name])}
							placeholder="Event"
							className="w-40 font-mono text-[13px]"
						/>
					) : (
						<Input
							aria-label="Event"
							placeholder="purchase"
							className="h-8 w-40 font-mono text-[13px]"
							value={c.name}
							onChange={(e) => set({ ...c, name: e.target.value.trim() })}
						/>
					)}
					{c.did && (
						<>
							<Words>at least</Words>
							<Num
								label="Times"
								value={c.min ?? 1}
								onChange={(min) => set({ ...c, min })}
								max={1000}
							/>
							<Words>{(c.min ?? 1) === 1 ? "time" : "times"}</Words>
						</>
					)}
					<Words>in the last</Words>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days })}
					/>
					<Words>days, where</Words>
					<Input
						aria-label="Data key"
						placeholder="plan"
						className="h-8 w-24 font-mono text-[13px]"
						value={c.key ?? ""}
						onChange={(e) =>
							set({
								...c,
								key: e.target.value.replace(/[^A-Za-z0-9_.-]/g, "") || undefined,
							})
						}
					/>
					<Words>is</Words>
					<Input
						aria-label="Data value"
						placeholder="pro"
						className="h-8 w-24"
						value={c.value ?? ""}
						onChange={(e) => set({ ...c, value: e.target.value || undefined })}
					/>
				</>
			);
		case "poll": {
			const poll = o.polls.find(
				(p) => p.broadcast_id === c.broadcast_id && (!c.poll_id || p.poll_id === c.poll_id),
			);
			return (
				<>
					<Pick
						label="Poll"
						value={poll ? `${poll.broadcast_id}|${poll.poll_id}` : ""}
						onChange={(v) => {
							const [broadcast_id, poll_id] = v.split("|");
							set({ ...c, broadcast_id: broadcast_id ?? "", poll_id, answer: 0 });
						}}
						items={o.polls.map((p) => [
							`${p.broadcast_id}|${p.poll_id}`,
							`${p.question} (${p.broadcast})`,
						])}
						placeholder={o.polls.length ? "Poll" : "No polls sent yet"}
						className="w-56"
					/>
					<Words>with</Words>
					<Pick
						label="Answer"
						value={String(c.answer)}
						onChange={(v) => set({ ...c, answer: Number(v) })}
						items={(poll?.options ?? []).map((x, i) => [String(i), x])}
						placeholder="Answer"
						className="w-36"
					/>
				</>
			);
		}
		case "referrals":
			return (
				<>
					<Words>at least</Words>
					<Num
						label="Friends"
						value={c.min}
						onChange={(min) => set({ ...c, min: min ?? 1 })}
						max={100_000}
					/>
					<Words>{c.min === 1 ? "friend" : "friends"}</Words>
				</>
			);
		case "conversation":
			return (
				<>
					<Pick
						label="Has or hasn't"
						value={c.did ? "has" : "hasnt"}
						onChange={(v) => set({ ...c, did: v === "has" })}
						items={[
							["has", "has"],
							["hasnt", "has no"],
						]}
						className="w-24"
					/>
					<Pick
						label="Which"
						value={c.status}
						onChange={(status) => set({ ...c, status })}
						items={[
							["any", "conversation"],
							["open", "open conversation"],
						]}
						className="w-44"
					/>
					<Words>from the last</Words>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days })}
					/>
					<Words>days</Words>
				</>
			);
		case "rating":
			return (
				<>
					<Words>latest is</Words>
					<Pick
						label="Comparison"
						value={c.op}
						onChange={(op) => set({ ...c, op })}
						items={[
							["at_most", "at most"],
							["at_least", "at least"],
						]}
						className="w-28"
					/>
					<Pick
						label="Stars"
						value={String(c.value)}
						onChange={(v) => set({ ...c, value: Number(v) })}
						items={[1, 2, 3, 4, 5].map((n) => [String(n), `${n} of 5`])}
						className="w-24"
					/>
					<Words>in the last</Words>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days })}
					/>
					<Words>days</Words>
				</>
			);
		case "survey": {
			const list = o.surveys ?? [];
			const s = list.find((x) => x.id === c.survey_id);
			const kind = s?.kind ?? "nps";
			const answers: [SurveyAnswer, string][] =
				kind === "nps"
					? [
							["any", "any answer"],
							["promoter", "a promoter (9-10)"],
							["passive", "a passive (7-8)"],
							["detractor", "a detractor (0-6)"],
							["at_least", "a score of at least"],
							["at_most", "a score of at most"],
						]
					: kind === "csat"
						? [
								["any", "any answer"],
								["at_least", "a score of at least"],
								["at_most", "a score of at most"],
							]
						: [
								["any", "any answer"],
								["choice", "the answer"],
							];
			const scale =
				kind === "nps"
					? Array.from(
							{ length: 11 },
							(_, i) => [String(i), String(i)] as [string, string],
						)
					: [1, 2, 3, 4, 5].map((i) => [String(i), `${i} of 5`] as [string, string]);
			return (
				<>
					<Pick
						label="Survey"
						value={c.survey_id}
						onChange={(survey_id) => {
							const next = list.find((x) => x.id === survey_id);
							set({
								...c,
								survey_id,
								answer: next?.kind === "choice" ? "choice" : "any",
								value: next?.kind === "choice" ? 0 : undefined,
							});
						}}
						items={list.map((x) => [x.id, x.name])}
						placeholder={list.length ? "Survey" : "No surveys yet"}
						className="w-44"
					/>
					<Words>latest is</Words>
					<Pick
						label="Answer"
						value={c.answer}
						onChange={(answer) =>
							set({
								...c,
								answer,
								value:
									answer === "at_least"
										? kind === "nps"
											? 9
											: 4
										: answer === "at_most"
											? kind === "nps"
												? 6
												: 2
											: answer === "choice"
												? 0
												: undefined,
							})
						}
						items={answers}
						className="w-48"
					/>
					{(c.answer === "at_least" || c.answer === "at_most") && (
						<Pick
							label="Score"
							value={String(c.value ?? 0)}
							onChange={(v) => set({ ...c, value: Number(v) })}
							items={scale}
							className="w-24"
						/>
					)}
					{c.answer === "choice" && (
						<Pick
							label="Which answer"
							value={String(c.value ?? 0)}
							onChange={(v) => set({ ...c, value: Number(v) })}
							items={(s?.options ?? []).map((x, i) => [String(i), x])}
							className="w-40"
						/>
					)}
					<Words>in the last</Words>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days })}
					/>
					<Words>days</Words>
				</>
			);
		}
		case "chatted":
			return (
				<>
					<Words>on a page with</Words>
					<Input
						aria-label="Page"
						placeholder="/pricing (any page)"
						className="h-8 w-44"
						value={c.page ?? ""}
						onChange={(e) => set({ ...c, page: e.target.value })}
					/>
					<Words>in the last</Words>
					<Num
						label="Days"
						value={c.days}
						onChange={(days) => set({ ...c, days })}
					/>
					<Words>days</Words>
				</>
			);
		case "lead_score":
			return (
				<>
					<Words>is</Words>
					<Pick
						label="Lead score"
						value={c.op}
						onChange={(op) =>
							set({
								...c,
								op,
								value:
									op === "at_least" || op === "at_most"
										? (c.value ?? 50)
										: undefined,
							})
						}
						items={[
							["hot", "a hot lead"],
							["warm", "a warm lead"],
							["cold", "a cold lead"],
							["at_least", "at least"],
							["at_most", "at most"],
						]}
						className="w-36"
					/>
					{(c.op === "at_least" || c.op === "at_most") && (
						<>
							<Num
								label="Points"
								value={c.value}
								onChange={(value) => set({ ...c, value })}
							/>
							<Words>points</Words>
						</>
					)}
				</>
			);
	}
}

const kindLabel = (t: Type) => KINDS.flatMap((g) => g.items).find(([k]) => k === t)?.[1] ?? t;

/** One rule: its kind and its fields (a live segment's row, or a lead scoring rule's check). */
export function ConditionEditor({
	c,
	set,
	options,
	exclude = [],
}: {
	c: SegmentCondition;
	set: (c: SegmentCondition) => void;
	options: RuleOptions;
	/** Kinds not offered. */
	exclude?: Type[];
}) {
	return (
		<>
			<Select
				value={c.type}
				onValueChange={(t) => set(newCondition(t as Type, options))}
			>
				<SelectTrigger
					aria-label="Kind of rule"
					className="w-52"
				>
					<SelectValue>{kindLabel(c.type)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{KINDS.map((g) => (
						<div key={g.group}>
							<p className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
								{g.group}
							</p>
							{g.items
								.filter(([k]) => !exclude.includes(k))
								.map(([k, l]) => (
									<SelectItem
										key={k}
										value={k}
									>
										{l}
									</SelectItem>
								))}
						</div>
					))}
				</SelectContent>
			</Select>
			<Fields
				c={c}
				set={set}
				o={options}
			/>
		</>
	);
}

/** The rules of a live segment: match all or any, and each rule as a row. */
export function SegmentRulesEditor({
	value,
	onChange,
	options,
}: {
	value: SegmentRules;
	onChange: (v: SegmentRules) => void;
	options: RuleOptions;
}) {
	const set = (i: number, c: SegmentCondition) =>
		onChange({ ...value, conditions: value.conditions.map((x, j) => (j === i ? c : x)) });
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 text-sm">
				<span className="text-muted-foreground">Contacts who match</span>
				<Pick
					label="All or any"
					value={value.match}
					onChange={(match) => onChange({ ...value, match })}
					items={[
						["all", "all"],
						["any", "any"],
					]}
					className="w-20"
				/>
				<span className="text-muted-foreground">of these rules</span>
			</div>
			<ul className="flex flex-col gap-2">
				{value.conditions.map((c, i) => (
					<li
						key={i}
						className="flex items-start gap-2 rounded-lg border bg-muted/30 p-2.5"
					>
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
							<ConditionEditor
								c={c}
								set={(x) => set(i, x)}
								options={options}
							/>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-8 shrink-0"
							aria-label="Remove this rule"
							disabled={value.conditions.length === 1}
							onClick={() =>
								onChange({
									...value,
									conditions: value.conditions.filter((_, j) => j !== i),
								})
							}
						>
							<X />
						</Button>
					</li>
				))}
			</ul>
			{value.conditions.length < 20 && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="self-start"
					onClick={() =>
						onChange({
							...value,
							conditions: [...value.conditions, newCondition("event", options)],
						})
					}
				>
					<Plus /> Add a rule
				</Button>
			)}
		</div>
	);
}
