/**
 * An automation as its page edits it: a tree of steps (a branching step's "yes" path is the steps
 * after it, its "no" path its own list), each with a key the canvas selects it by.
 */

export type Unit = "minutes" | "hours" | "days";
export type StepType =
	| "wait"
	| "send"
	| "email"
	| "condition"
	| "wait_event"
	| "split"
	| "segment"
	| "property"
	| "score"
	| "topic"
	| "newsletter"
	| "notify"
	| "conversation"
	| "webhook";
export type Check = "segment" | "property" | "opened" | "clicked";
export type ConversationAction = "tag" | "priority" | "assign" | "resolve";

/** The steps with a "no" path of their own. */
export const BRANCHING = new Set<StepType>(["condition", "wait_event", "split"]);

export type Step = {
	key: string;
	type: StepType;
	amount: string;
	unit: Unit;
	template_id: string;
	subject: string;
	from: string;
	check: Check;
	segment_id: string;
	property: string;
	equals: string;
	action: "add" | "remove";
	value: string;
	/** wait_event */
	event: string;
	/** split */
	percent: string;
	/** email */
	body: string;
	/** score */
	add: string;
	/** topic */
	topic_id: string;
	topic_value: "opt_in" | "opt_out";
	/** newsletter */
	newsletter_id: string;
	newsletter_action: "subscribe" | "remove";
	/** notify */
	to: string[];
	message: string;
	/** conversation */
	conversation_action: ConversationAction;
	/** webhook */
	url: string;
	no: Step[];
};

export type TriggerType =
	| "contact.created"
	| "segment.joined"
	| "event"
	| "email.opened"
	| "email.clicked"
	| "form.submitted"
	| "unsubscribed"
	| "topic.changed"
	| "property.changed"
	| "date"
	| "inactive"
	| "conversation.opened"
	| "conversation.resolved"
	| "conversation.rated";

export type Form = {
	name: string;
	trigger: TriggerType;
	segment_id: string;
	event: string;
	broadcast_id: string;
	link: string;
	form_id: string;
	topic_id: string;
	topic_value: "opt_in" | "opt_out";
	key: string;
	equals: string;
	/** date: days from the date (negative: before it). */
	offset: string;
	yearly: boolean;
	days: string;
	inbox_id: string;
	channel: "" | "email" | "chat";
	op: "at_most" | "at_least";
	rating: string;
	reentry: boolean;
	goal_event: string;
	steps: Step[];
};

/** A stored step, as the API gives it. */
export type SavedStep =
	| { type: "wait"; minutes: number }
	| { type: "send"; template_id: string; from?: string | null; subject?: string | null }
	| {
			type: "condition";
			segment_id?: string | null;
			property?: string | null;
			equals?: string | number | null;
			engaged?: "opened" | "clicked" | null;
			no?: SavedStep[] | null;
	  }
	| { type: "wait_event"; event: string; minutes: number; no?: SavedStep[] | null }
	| { type: "split"; percent: number; no?: SavedStep[] | null }
	| { type: "segment"; action: "add" | "remove"; segment_id: string }
	| { type: "property"; key: string; value: string | number }
	| { type: "score"; key: string; add: number }
	| { type: "topic"; topic_id: string; value: "opt_in" | "opt_out" }
	| { type: "newsletter"; newsletter_id: string; action: "subscribe" | "remove" }
	| { type: "notify"; to: string[]; message: string }
	| { type: "conversation"; action: ConversationAction; value?: string | null }
	| { type: "webhook"; url: string }
	| { type: "email"; from: string; subject: string; body: string };

export type SavedTrigger =
	| { type: "contact.created"; segment_id?: string | null }
	| { type: "segment.joined"; segment_id: string }
	| { type: "event"; event: string }
	| { type: "email.opened"; broadcast_id?: string | null }
	| { type: "email.clicked"; broadcast_id?: string | null; link?: string | null }
	| { type: "form.submitted"; form_id?: string | null }
	| { type: "unsubscribed" }
	| { type: "topic.changed"; topic_id: string; value: "opt_in" | "opt_out" }
	| { type: "property.changed"; key: string; equals?: string | null }
	| { type: "date"; key: string; offset_days: number; yearly: boolean }
	| { type: "inactive"; days: number }
	| { type: "conversation.opened"; inbox_id?: string | null; channel?: "email" | "chat" | null }
	| { type: "conversation.resolved"; inbox_id?: string | null }
	| { type: "conversation.rated"; op: "at_most" | "at_least"; rating: number };

let seq = 0;
export const newKey = () => `s${seq++}`;

export const blank = (type: StepType): Step => ({
	key: newKey(),
	type,
	amount: type === "wait_event" ? "3" : "1",
	unit: "days",
	template_id: "",
	subject: "",
	from: "",
	check: "opened",
	segment_id: "",
	property: "",
	equals: "",
	action: "add",
	value: "",
	event: "",
	percent: "50",
	body: "",
	add: "1",
	topic_id: "",
	topic_value: "opt_in",
	newsletter_id: "",
	newsletter_action: "subscribe",
	to: [],
	message: "",
	conversation_action: "tag",
	url: "",
	no: [],
});

export function waitOf(minutes: number): { amount: string; unit: Unit } {
	if (minutes % 1440 === 0) return { amount: String(minutes / 1440), unit: "days" };
	if (minutes % 60 === 0) return { amount: String(minutes / 60), unit: "hours" };
	return { amount: String(minutes), unit: "minutes" };
}

function stepOf(s: SavedStep): Step {
	const b = blank(s.type);
	switch (s.type) {
		case "wait":
			return { ...b, ...waitOf(s.minutes) };
		case "send":
			return {
				...b,
				template_id: s.template_id,
				subject: s.subject ?? "",
				from: s.from ?? "",
			};
		case "email":
			return { ...b, from: s.from, subject: s.subject, body: s.body };
		case "segment":
			return { ...b, action: s.action, segment_id: s.segment_id };
		case "property":
			return { ...b, property: s.key, value: String(s.value) };
		case "score":
			return { ...b, property: s.key, add: String(s.add) };
		case "topic":
			return { ...b, topic_id: s.topic_id, topic_value: s.value };
		case "newsletter":
			return { ...b, newsletter_id: s.newsletter_id, newsletter_action: s.action };
		case "notify":
			return { ...b, to: s.to, message: s.message };
		case "conversation":
			return { ...b, conversation_action: s.action, value: s.value ?? "" };
		case "webhook":
			return { ...b, url: s.url };
		case "wait_event":
			return { ...b, event: s.event, ...waitOf(s.minutes), no: (s.no ?? []).map(stepOf) };
		case "split":
			return { ...b, percent: String(s.percent), no: (s.no ?? []).map(stepOf) };
		case "condition":
			return {
				...b,
				check: s.engaged ?? (s.segment_id ? "segment" : "property"),
				segment_id: s.segment_id ?? "",
				property: s.property ?? "",
				equals: s.equals === null || s.equals === undefined ? "" : String(s.equals),
				no: (s.no ?? []).map(stepOf),
			};
	}
}

export const formOf = (x: {
	name: string;
	trigger: SavedTrigger;
	reentry: boolean;
	goal_event?: string | null;
	steps: SavedStep[];
}): Form => {
	const t = x.trigger;
	return {
		name: x.name,
		trigger: t.type,
		segment_id:
			t.type === "contact.created" || t.type === "segment.joined" ? (t.segment_id ?? "") : "",
		event: t.type === "event" ? t.event : "",
		broadcast_id:
			t.type === "email.opened" || t.type === "email.clicked" ? (t.broadcast_id ?? "") : "",
		link: t.type === "email.clicked" ? (t.link ?? "") : "",
		form_id: t.type === "form.submitted" ? (t.form_id ?? "") : "",
		topic_id: t.type === "topic.changed" ? t.topic_id : "",
		topic_value: t.type === "topic.changed" ? t.value : "opt_in",
		key: t.type === "property.changed" || t.type === "date" ? t.key : "",
		equals: t.type === "property.changed" ? (t.equals ?? "") : "",
		offset: t.type === "date" ? String(t.offset_days) : "0",
		yearly: t.type === "date" ? t.yearly : true,
		days: t.type === "inactive" ? String(t.days) : "60",
		inbox_id:
			t.type === "conversation.opened" || t.type === "conversation.resolved"
				? (t.inbox_id ?? "")
				: "",
		channel: t.type === "conversation.opened" ? (t.channel ?? "") : "",
		op: t.type === "conversation.rated" ? t.op : "at_most",
		rating: t.type === "conversation.rated" ? String(t.rating) : "2",
		reentry: x.reentry,
		goal_event: x.goal_event ?? "",
		steps: x.steps.map(stepOf),
	};
};

const MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const minutes = (s: Step) => Math.round(Number(s.amount) * MINUTES[s.unit]);
const no = (s: Step) => (s.no.length ? { no: s.no.map(savedOf) } : {});

function savedOf(s: Step): SavedStep {
	switch (s.type) {
		case "wait":
			return { type: "wait", minutes: minutes(s) };
		case "send":
			return {
				type: "send",
				template_id: s.template_id,
				subject: s.subject || null,
				from: s.from || null,
			};
		case "email":
			return { type: "email", from: s.from.trim(), subject: s.subject, body: s.body };
		case "segment":
			return { type: "segment", action: s.action, segment_id: s.segment_id };
		case "property":
			return { type: "property", key: s.property.trim(), value: s.value };
		case "score":
			return { type: "score", key: s.property.trim(), add: Number(s.add) || 0 };
		case "topic":
			return { type: "topic", topic_id: s.topic_id, value: s.topic_value };
		case "newsletter":
			return {
				type: "newsletter",
				newsletter_id: s.newsletter_id,
				action: s.newsletter_action,
			};
		case "notify":
			return { type: "notify", to: s.to, message: s.message };
		case "conversation":
			return {
				type: "conversation",
				action: s.conversation_action,
				value: s.conversation_action === "resolve" ? null : s.value.trim() || null,
			};
		case "webhook":
			return { type: "webhook", url: s.url.trim() };
		case "wait_event":
			return { type: "wait_event", event: s.event.trim(), minutes: minutes(s), ...no(s) };
		case "split":
			return { type: "split", percent: Math.round(Number(s.percent)) || 50, ...no(s) };
		case "condition":
			return {
				type: "condition",
				segment_id: s.check === "segment" ? s.segment_id || null : null,
				property: s.check === "property" ? s.property || null : null,
				equals: s.check === "property" && s.equals ? s.equals : null,
				engaged: s.check === "opened" || s.check === "clicked" ? s.check : null,
				...no(s),
			};
	}
}

function triggerOf(f: Form): SavedTrigger {
	const t = f.trigger;
	switch (t) {
		case "event":
			return { type: t, event: f.event.trim() };
		case "email.opened":
			return { type: t, broadcast_id: f.broadcast_id || null };
		case "email.clicked":
			return { type: t, broadcast_id: f.broadcast_id || null, link: f.link.trim() || null };
		case "form.submitted":
			return { type: t, form_id: f.form_id || null };
		case "unsubscribed":
			return { type: t };
		case "topic.changed":
			return { type: t, topic_id: f.topic_id, value: f.topic_value };
		case "property.changed":
			return { type: t, key: f.key.trim(), equals: f.equals.trim() || null };
		case "date":
			return {
				type: t,
				key: f.key.trim(),
				offset_days: Math.round(Number(f.offset)) || 0,
				yearly: f.yearly,
			};
		case "inactive":
			return { type: t, days: Math.round(Number(f.days)) || 60 };
		case "conversation.opened":
			return { type: t, inbox_id: f.inbox_id || null, channel: f.channel || null };
		case "conversation.resolved":
			return { type: t, inbox_id: f.inbox_id || null };
		case "conversation.rated":
			return { type: t, op: f.op, rating: Number(f.rating) || 2 };
		case "segment.joined":
			return { type: t, segment_id: f.segment_id };
		default:
			return { type: "contact.created", segment_id: f.segment_id || null };
	}
}

export const toFields = (f: Form) => ({
	name: f.name,
	trigger: triggerOf(f),
	reentry: f.reentry,
	goal_event: f.goal_event.trim() || null,
	steps: f.steps.map(savedOf),
});

// ── The tree ────────────────────────────────────────────────────────────────

/**
 * A list of steps by where it is: [] the top level, [i] the "no" steps of the branching step at
 * i, [i, j] those of the one at j in them, and so on.
 */
export type ListPath = number[];

export function listAt(steps: Step[], at: ListPath): Step[] {
	let list = steps;
	for (const i of at) list = list[i]?.no ?? [];
	return list;
}

function withList(steps: Step[], at: ListPath, fn: (list: Step[]) => Step[]): Step[] {
	if (!at.length) return fn(steps);
	const [i, ...rest] = at as [number, ...number[]];
	return steps.map((s, j) => (j === i ? { ...s, no: withList(s.no, rest, fn) } : s));
}

export const insertStep = (steps: Step[], at: ListPath, index: number, step: Step) =>
	withList(steps, at, (list) => [...list.slice(0, index), step, ...list.slice(index)]);

export function mapSteps(steps: Step[], fn: (s: Step) => Step): Step[] {
	return steps.map((s) => {
		const out = fn(s);
		return out.no.length ? { ...out, no: mapSteps(out.no, fn) } : out;
	});
}

export const updateStep = (steps: Step[], key: string, change: Partial<Step>) =>
	mapSteps(steps, (s) => (s.key === key ? { ...s, ...change } : s));

/** Takes a step out (a branching one with its "no" steps; its "yes" path stays). */
export function removeStep(steps: Step[], key: string): Step[] {
	return steps
		.filter((s) => s.key !== key)
		.map((s) => (s.no.length ? { ...s, no: removeStep(s.no, key) } : s));
}

export function findStep(steps: Step[], key: string): Step | null {
	for (const s of steps) {
		if (s.key === key) return s;
		const inner = findStep(s.no, key);
		if (inner) return inner;
	}
	return null;
}

export function countSteps(steps: Step[]): number {
	return steps.reduce((n, s) => n + 1 + countSteps(s.no), 0);
}

/** The step a run's place points at (its index path, as the server keeps it). */
export function stepAtPath(steps: Step[], path: number[]): Step | null {
	let list = steps;
	for (const i of path.slice(0, -1)) list = list[i]?.no ?? [];
	return list[path.at(-1) ?? 0] ?? null;
}

const EVENT = /^[A-Za-z0-9_.:-]{1,100}$/;

/** What a step still needs before it can run, if anything. */
export function stepNeeds(s: Step): string | null {
	switch (s.type) {
		case "send":
			return s.template_id ? null : "Pick a template";
		case "email":
			if (!s.from.trim()) return "Add a From";
			if (!s.subject.trim()) return "Write a subject";
			return s.body.trim() ? null : "Write the email";
		case "segment":
			return s.segment_id ? null : "Pick a segment";
		case "property":
		case "score":
			return s.property.trim() ? null : "Pick a property";
		case "topic":
			return s.topic_id ? null : "Pick a topic";
		case "newsletter":
			return s.newsletter_id ? null : "Pick a newsletter";
		case "notify":
			if (!s.to.length) return "Pick who to tell";
			return s.message.trim() ? null : "Write the message";
		case "conversation":
			return s.conversation_action === "resolve" || s.value.trim()
				? null
				: "Choose the value";
		case "webhook":
			return /^https:\/\/\S+$/.test(s.url.trim()) ? null : "Add an https URL";
		case "wait":
			return Number(s.amount) > 0 ? null : "Set how long";
		case "wait_event":
			if (!EVENT.test(s.event.trim())) return "Name the event";
			return Number(s.amount) > 0 ? null : "Set how long at most";
		case "split": {
			const n = Number(s.percent);
			return n >= 1 && n <= 99 ? null : "1 to 99%";
		}
		case "condition":
			if (s.check === "segment" && !s.segment_id) return "Pick a segment";
			if (s.check === "property" && !s.property.trim()) return "Name a property";
			return null;
	}
}

export function triggerNeeds(f: Form): string | null {
	switch (f.trigger) {
		case "segment.joined":
			return f.segment_id ? null : "Pick a segment";
		case "event":
			return f.event.trim() ? null : "Name the event";
		case "topic.changed":
			return f.topic_id ? null : "Pick a topic";
		case "property.changed":
		case "date":
			return f.key.trim() ? null : "Pick a property";
		case "inactive":
			return Number(f.days) >= 7 ? null : "7 days or more";
		default:
			return null;
	}
}
