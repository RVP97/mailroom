/**
 * An automation as its page edits it: a tree of steps (a condition's "yes" path is the steps after
 * it, its "no" path its own list), each with a key the canvas selects it by.
 */

export type Unit = "minutes" | "hours" | "days";
export type StepType = "wait" | "send" | "condition" | "segment" | "property";
export type Check = "segment" | "property" | "opened" | "clicked";

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
	no: Step[];
};

export type TriggerType =
	| "contact.created"
	| "segment.joined"
	| "event"
	| "email.opened"
	| "email.clicked";

export type Form = {
	name: string;
	trigger: TriggerType;
	segment_id: string;
	event: string;
	broadcast_id: string;
	link: string;
	reentry: boolean;
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
	| { type: "segment"; action: "add" | "remove"; segment_id: string }
	| { type: "property"; key: string; value: string | number };

export type SavedTrigger =
	| { type: "contact.created"; segment_id?: string | null }
	| { type: "segment.joined"; segment_id: string }
	| { type: "event"; event: string }
	| { type: "email.opened"; broadcast_id?: string | null }
	| { type: "email.clicked"; broadcast_id?: string | null; link?: string | null };

let seq = 0;
export const newKey = () => `s${seq++}`;

export const blank = (type: StepType): Step => ({
	key: newKey(),
	type,
	amount: "1",
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
		case "segment":
			return { ...b, action: s.action, segment_id: s.segment_id };
		case "property":
			return { ...b, property: s.key, value: String(s.value) };
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
		reentry: x.reentry,
		steps: x.steps.map(stepOf),
	};
};

const MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

function savedOf(s: Step): SavedStep {
	switch (s.type) {
		case "wait":
			return { type: "wait", minutes: Math.round(Number(s.amount) * MINUTES[s.unit]) };
		case "send":
			return {
				type: "send",
				template_id: s.template_id,
				subject: s.subject || null,
				from: s.from || null,
			};
		case "segment":
			return { type: "segment", action: s.action, segment_id: s.segment_id };
		case "property":
			return {
				type: "property",
				key: s.property.trim(),
				value: s.value,
			};
		case "condition":
			return {
				type: "condition",
				segment_id: s.check === "segment" ? s.segment_id || null : null,
				property: s.check === "property" ? s.property || null : null,
				equals: s.check === "property" && s.equals ? s.equals : null,
				engaged: s.check === "opened" || s.check === "clicked" ? s.check : null,
				...(s.no.length ? { no: s.no.map(savedOf) } : {}),
			};
	}
}

export const toFields = (f: Form) => {
	const t = f.trigger;
	return {
		name: f.name,
		trigger:
			t === "event"
				? { type: t, event: f.event.trim() }
				: t === "email.opened"
					? { type: t, broadcast_id: f.broadcast_id || null }
					: t === "email.clicked"
						? {
								type: t,
								broadcast_id: f.broadcast_id || null,
								link: f.link.trim() || null,
							}
						: { type: t, segment_id: f.segment_id || null },
		reentry: f.reentry,
		steps: f.steps.map(savedOf),
	};
};

// ── The tree ────────────────────────────────────────────────────────────────

/**
 * A list of steps by where it is: [] the top level, [i] the "no" steps of the condition at i,
 * [i, j] those of the condition at j in them, and so on.
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

/** Takes a step out (a condition with its "no" steps; its "yes" path stays). */
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

/** What a step still needs before it can run, if anything. */
export function stepNeeds(s: Step): string | null {
	if (s.type === "send" && !s.template_id) return "Pick a template";
	if (s.type === "segment" && !s.segment_id) return "Pick a segment";
	if (s.type === "property" && !s.property.trim()) return "Pick a property";
	if (s.type === "wait" && !(Number(s.amount) > 0)) return "Set how long";
	if (s.type === "condition") {
		if (s.check === "segment" && !s.segment_id) return "Pick a segment";
		if (s.check === "property" && !s.property.trim()) return "Name a property";
	}
	return null;
}

export function triggerNeeds(f: Form): string | null {
	if (f.trigger === "segment.joined" && !f.segment_id) return "Pick a segment";
	if (f.trigger === "event" && !f.event.trim()) return "Name the event";
	return null;
}
