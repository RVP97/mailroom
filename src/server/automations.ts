import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { fill, htmlToText } from "../lib/template-fill";
import { orgOf } from "./brands";
import { type EventSource, storeEvent } from "./contact-events";
import {
	ALL_BROADCASTS_GROUP,
	type Contact,
	contactValues,
	getContact,
	listSegmentOf,
	segmentOf,
	upsertContact,
} from "./contacts";
import { db, raw, schema } from "./db";
import { retrying } from "./db/retry";
import type { AutomationStatus, AutomationStep, AutomationTrigger } from "./db/schema";
import { ApiError, notFound, validation } from "./errors";
import { createEmails, parseSend } from "./send";
import { getTemplate, variableValues } from "./templates";
import { iso } from "./time";

/**
 * Automations, like Resend's: a trigger and steps, per brand. A trigger (a contact added, a
 * segment joined, or an event from POST /events) starts a run for the contact; the cron moves
 * runs on every minute (runAutomations): a wait sets when the next step is due, a send queues the
 * template's email for the Dispatcher (to the contact, filled in with their values and the
 * event's), a condition ends the run when it doesn't hold. Runs live in D1, so nothing is lost
 * between minutes. Contacts imported from a file don't start automations.
 */

export type Automation = typeof schema.automations.$inferSelect;
export type AutomationRun = typeof schema.automationRuns.$inferSelect;
const a = schema.automations;
const r = schema.automationRuns;

/** Runs moved on per cron minute, and steps one run may take in a go. */
const RUNS_PER_MINUTE = 200;
const STEPS_PER_GO = 20;
const CLAIM_MS = 5 * 60_000;
const MAX_WAIT_MINUTES = 90 * 24 * 60;

const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,100}$/;

const trigger = z.discriminatedUnion("type", [
	z.object({ type: z.literal("contact.created"), segment_id: z.string().nullish() }),
	z.object({ type: z.literal("segment.joined"), segment_id: z.string().min(1) }),
	z.object({
		type: z.literal("event"),
		event: z.string().regex(EVENT_NAME, "event: letters, numbers, _ . : and - (up to 100)"),
	}),
	z.object({ type: z.literal("email.opened"), broadcast_id: z.string().nullish() }),
	z.object({
		type: z.literal("email.clicked"),
		broadcast_id: z.string().nullish(),
		link: z.string().trim().max(2000).nullish(),
	}),
	z.object({ type: z.literal("form.submitted"), form_id: z.string().nullish() }),
	z.object({ type: z.literal("unsubscribed") }),
	z.object({
		type: z.literal("topic.changed"),
		topic_id: z.string().min(1, "pick a topic"),
		value: z.enum(["opt_in", "opt_out"]),
	}),
	z.object({
		type: z.literal("property.changed"),
		key: z.string().trim().min(1, "pick a property").max(100),
		equals: z.string().max(500).nullish(),
	}),
	z.object({
		type: z.literal("date"),
		key: z.string().trim().min(1, "pick a property").max(100),
		offset_days: z.number().int().min(-365).max(365),
		yearly: z.boolean(),
	}),
	z.object({ type: z.literal("inactive"), days: z.number().int().min(7).max(365) }),
	z.object({
		type: z.literal("conversation.opened"),
		inbox_id: z.string().nullish(),
		channel: z.enum(["email", "chat"]).nullish(),
	}),
	z.object({ type: z.literal("conversation.resolved"), inbox_id: z.string().nullish() }),
	z.object({
		type: z.literal("conversation.rated"),
		op: z.enum(["at_most", "at_least"]),
		rating: z.number().int().min(1).max(5),
	}),
]);

/** Steps in all, counting each condition's "no" steps, and how deep conditions may nest. */
const MAX_STEPS = 40;
const MAX_DEPTH = 4;

type Branching =
	| z.input<typeof conditionStep>
	| z.input<typeof waitEventStep>
	| z.input<typeof splitStep>;
type StepIn = z.input<typeof leaf> | (Branching & { no?: StepIn[] | null });
/** Waits for an event; on time out, the "no" steps. */
const waitEventStep = z.object({
	type: z.literal("wait_event"),
	event: z.string().regex(EVENT_NAME, "event: letters, numbers, _ . : and - (up to 100)"),
	minutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).optional(),
	hours: z
		.number()
		.min(0)
		.max(MAX_WAIT_MINUTES / 60)
		.optional(),
	days: z.number().min(0).max(90).optional(),
});
const splitStep = z.object({
	type: z.literal("split"),
	percent: z.number().int().min(1).max(99),
});
const conditionStep = z.object({
	type: z.literal("condition"),
	segment_id: z.string().nullish(),
	property: z.string().nullish(),
	equals: z.union([z.string(), z.number()]).nullish(),
	engaged: z.enum(["opened", "clicked"]).nullish(),
});

const leaf = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("wait"),
		minutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).optional(),
		hours: z
			.number()
			.min(0)
			.max(MAX_WAIT_MINUTES / 60)
			.optional(),
		days: z.number().min(0).max(90).optional(),
	}),
	z.object({
		type: z.literal("send"),
		template_id: z.string().min(1),
		from: z.string().trim().max(320).nullish(),
		subject: z.string().max(998).nullish(),
		variables: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
	}),
	z.object({
		type: z.literal("segment"),
		action: z.enum(["add", "remove"]),
		segment_id: z.string().min(1),
	}),
	z.object({
		type: z.literal("property"),
		key: z.string().trim().min(1, "pick a property").max(100),
		value: z.union([z.string().max(2000), z.number()]),
	}),
	z.object({
		type: z.literal("notify"),
		to: z.array(z.string().trim().email()).min(1).max(10),
		message: z.string().trim().min(1).max(2000),
	}),
	z.object({
		type: z.literal("conversation"),
		action: z.enum(["tag", "priority", "assign", "resolve"]),
		value: z.string().trim().max(100).nullish(),
	}),
	z.object({
		type: z.literal("topic"),
		topic_id: z.string().min(1, "pick a topic"),
		value: z.enum(["opt_in", "opt_out"]),
	}),
	z.object({
		type: z.literal("newsletter"),
		newsletter_id: z.string().min(1),
		action: z.enum(["subscribe", "remove"]),
	}),
	z.object({
		type: z.literal("webhook"),
		url: z
			.string()
			.trim()
			.url()
			.max(2000)
			.refine((u) => u.startsWith("https://"), "the URL must use https"),
	}),
	z.object({
		type: z.literal("email"),
		from: z.string().trim().min(3).max(320),
		subject: z.string().trim().min(1).max(998),
		body: z.string().trim().min(1).max(20_000),
	}),
	z.object({
		type: z.literal("score"),
		key: z.string().trim().min(1, "pick a property").max(100),
		add: z.number().min(-1_000_000).max(1_000_000),
	}),
]);

const step: z.ZodType<StepIn> = z.lazy(() =>
	z.union([
		leaf,
		conditionStep.extend({ no: z.array(step).nullish() }),
		waitEventStep.extend({ no: z.array(step).nullish() }),
		splitStep.extend({ no: z.array(step).nullish() }),
	]),
);

export const automationInput = z.object({
	name: z.string().trim().min(1).max(200),
	status: z.enum(["draft", "active", "paused"]).optional(),
	trigger,
	steps: z.array(step).max(MAX_STEPS),
	reentry: z.boolean().optional(),
	/** The goal: when the contact does this event, their run ends there, as reached. */
	goal_event: z
		.string()
		.regex(EVENT_NAME, "goal_event: letters, numbers, _ . : and - (up to 100)")
		.nullish(),
});

/** The steps with a "no" path of their own. */
export type BranchStep = Extract<AutomationStep, { type: "condition" | "wait_event" | "split" }>;
export const branches = (s: AutomationStep | undefined): s is BranchStep =>
	s?.type === "condition" || s?.type === "wait_event" || s?.type === "split";

/** Every step, the "no" steps of conditions too. */
export function eachStep(steps: AutomationStep[], at: number[] = []): [AutomationStep, number[]][] {
	return steps.flatMap((s, i) => [
		[s, [...at, i]] as [AutomationStep, number[]],
		...(branches(s) && s.no ? eachStep(s.no, [...at, i]) : []),
	]);
}

const minutesOf = (s: { minutes?: number; hours?: number; days?: number }) =>
	Math.round((s.minutes ?? 0) + (s.hours ?? 0) * 60 + (s.days ?? 0) * 24 * 60);

function normalizeAll(list: StepIn[], depth = 0): AutomationStep[] {
	if (depth > MAX_DEPTH) throw validation(`Conditions go ${MAX_DEPTH} deep at most`);
	const out = list.map((s) => normalize(s, depth));
	if (depth === 0 && eachStep(out).length > MAX_STEPS)
		throw validation(`An automation has ${MAX_STEPS} steps at most`);
	return out;
}

/** A step as stored: waits in minutes. */
function normalize(s: StepIn, depth: number): AutomationStep {
	if (s.type === "wait") {
		const minutes = minutesOf(s);
		if (minutes < 1) throw validation("A wait step needs minutes, hours or days");
		return { type: "wait", minutes: Math.min(minutes, MAX_WAIT_MINUTES) };
	}
	const no = (list?: StepIn[] | null) =>
		list?.length ? { no: normalizeAll(list, depth + 1) } : {};
	if (s.type === "wait_event") {
		const minutes = minutesOf(s);
		if (minutes < 1) throw validation("A wait for an event needs how long to wait at most");
		return {
			type: "wait_event",
			event: s.event,
			minutes: Math.min(minutes, MAX_WAIT_MINUTES),
			...no(s.no),
		};
	}
	if (s.type === "split") return { type: "split", percent: s.percent, ...no(s.no) };
	if (
		s.type === "notify" ||
		s.type === "topic" ||
		s.type === "newsletter" ||
		s.type === "webhook" ||
		s.type === "email" ||
		s.type === "score"
	)
		return s;
	if (s.type === "conversation") {
		if (s.action !== "resolve" && !s.value)
			throw validation(`A ${s.action} step needs a value`);
		if (s.action === "priority" && !["urgent", "high", "normal", "low"].includes(s.value ?? ""))
			throw validation("priority: urgent, high, normal or low");
		return { type: "conversation", action: s.action, value: s.value || null };
	}
	if (s.type === "send")
		return {
			type: "send",
			template_id: s.template_id,
			from: s.from || null,
			subject: s.subject || null,
			...(s.variables ? { variables: s.variables } : {}),
		};
	if (s.type === "segment")
		return { type: "segment", action: s.action, segment_id: s.segment_id };
	if (s.type === "property") return { type: "property", key: s.key, value: s.value };
	if (!s.segment_id && !s.property && !s.engaged)
		throw validation("A condition step needs segment_id, property or engaged");
	return {
		type: "condition",
		segment_id: s.segment_id || null,
		property: s.property || null,
		equals: s.equals ?? null,
		engaged: s.engaged ?? null,
		...no(s.no),
	};
}

export const automationView = (x: Automation) => ({
	object: "automation",
	id: x.id,
	brand_id: x.organization_id,
	name: x.name,
	status: x.status,
	trigger: x.trigger,
	steps: x.steps,
	reentry: x.reentry,
	goal_event: x.goal_event ?? null,
	created_at: x.created_at,
	updated_at: x.updated_at,
});

/** What an active automation needs: its segments are the brand's and its templates published. */
async function check(brand: string, t: AutomationTrigger, steps: AutomationStep[]) {
	await checkTrigger(brand, t);
	const org = await orgOf(brand);
	for (const [s, at] of eachStep(steps)) {
		const i = at.join(".no.");
		if (s.type === "send") {
			const tpl = await getTemplate(org, s.template_id).catch(() => {
				throw validation(`steps[${i}].template_id: no template ${s.template_id}`);
			});
			if (!tpl.published)
				throw validation(`steps[${i}]: the template ${tpl.name} isn't published yet`);
			if (!s.from && !tpl.published.from)
				throw validation(`steps[${i}]: give a from (the template has no default From)`);
		}
		if (s.type === "condition" && s.segment_id) await segmentOf(brand, s.segment_id);
		if (s.type === "segment" && s.segment_id) await listSegmentOf(brand, s.segment_id);
		if (s.type === "topic")
			await owned(schema.topics, brand, s.topic_id, `steps[${i}].topic_id`);
		if (s.type === "notify") {
			const team = await teamAddresses(brand, s.to);
			const outside = s.to.filter((t) => !team.includes(t));
			if (outside.length)
				throw validation(`steps[${i}].to: ${outside.join(", ")} isn't on your team`);
		}
		if (s.type === "newsletter")
			await owned(schema.newsletters, brand, s.newsletter_id, `steps[${i}].newsletter_id`);
		if (s.type === "email") {
			const { domainFor, orgContext } = await import("./org");
			const { bareAddress } = await import("./aws/mime");
			const d = domainFor(await orgContext(brand), bareAddress(s.from));
			if (!d?.verified)
				throw validation(
					`steps[${i}].from: send from one of this brand's verified domains`,
				);
		}
	}
	if (!steps.length) throw validation("Add a step before turning it on");
}

/** Refuses an id that isn't one of the brand's rows of `table`. */
async function owned(
	table:
		| typeof schema.topics
		| typeof schema.newsletters
		| typeof schema.signupForms
		| typeof schema.inboxes,
	brand: string,
	id: string,
	field: string,
) {
	const row = await db
		.select({ id: table.id })
		.from(table)
		.where(and(eq(table.id, id), eq(table.organization_id, brand)))
		.get();
	if (!row) throw validation(`${field}: no such one in this brand`);
}

async function checkTrigger(brand: string, t: AutomationTrigger) {
	if ((t.type === "contact.created" || t.type === "segment.joined") && t.segment_id)
		await segmentOf(brand, t.segment_id);
	if ((t.type === "email.opened" || t.type === "email.clicked") && t.broadcast_id) {
		const b = await db
			.select({ id: schema.broadcasts.id })
			.from(schema.broadcasts)
			.where(
				and(
					eq(schema.broadcasts.id, t.broadcast_id),
					eq(schema.broadcasts.organization_id, brand),
				),
			)
			.get();
		if (!b) throw validation(`trigger.broadcast_id: no broadcast ${t.broadcast_id}`);
	}
	if (t.type === "form.submitted" && t.form_id)
		await owned(schema.signupForms, brand, t.form_id, "trigger.form_id");
	if (t.type === "topic.changed")
		await owned(schema.topics, brand, t.topic_id, "trigger.topic_id");
	if ((t.type === "conversation.opened" || t.type === "conversation.resolved") && t.inbox_id)
		await owned(schema.inboxes, brand, t.inbox_id, "trigger.inbox_id");
}

export async function listAutomations(brands: string[]) {
	return db
		.select()
		.from(a)
		.where(inArray(a.organization_id, brands))
		.orderBy(desc(a.created_at))
		.limit(200);
}

export async function getAutomation(brands: string | string[], id: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	const row = await db
		.select()
		.from(a)
		.where(and(eq(a.id, id), inArray(a.organization_id, list)))
		.get();
	if (!row) throw notFound("Automation");
	return row;
}

export async function createAutomation(brand: string, raw: unknown, now = Date.now()) {
	const v = automationInput.parse(raw);
	const steps = normalizeAll(v.steps);
	const status = v.status ?? "draft";
	if (status === "active") await check(brand, v.trigger as AutomationTrigger, steps);
	else await checkTrigger(brand, v.trigger as AutomationTrigger);
	const [row] = await db
		.insert(a)
		.values({
			id: crypto.randomUUID(),
			organization_id: brand,
			name: v.name,
			status,
			trigger: v.trigger as AutomationTrigger,
			steps,
			reentry: v.reentry ?? false,
			goal_event: v.goal_event || null,
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as Automation;
}

/** A copy with the same trigger and steps, as a draft nobody has gone through yet. */
export async function duplicateAutomation(brands: string | string[], id: string, now = Date.now()) {
	const x = await getAutomation(brands, id);
	const [row] = await db
		.insert(a)
		.values({
			...x,
			id: crypto.randomUUID(),
			name: `${x.name} (copy)`.slice(0, 200),
			status: "draft",
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as Automation;
}

/** Changes it; runs under way go on with the new steps from where they are. */
export async function updateAutomation(brand: string, id: string, raw: unknown, now = Date.now()) {
	const x = await getAutomation(brand, id);
	const v = automationInput.partial().parse(raw ?? {});
	const t = (v.trigger as AutomationTrigger | undefined) ?? x.trigger;
	const steps = v.steps ? normalizeAll(v.steps) : x.steps;
	const status = v.status ?? x.status;
	if (status === "active") await check(brand, t, steps);
	// Runs under way keep their place by step number: steps may be changed and added, but not
	// removed or moved while someone is part-way through (they'd land on another step).
	if (v.steps && !sameShape(x.steps, steps)) {
		const under = await db
			.select({ id: r.id })
			.from(r)
			.where(and(eq(r.automation_id, id), eq(r.status, "active")))
			.get();
		if (under)
			throw new ApiError(
				409,
				"runs_under_way",
				"Contacts are part-way through this automation: you can change steps and add new ones at the end, but removing or reordering steps would move them to the wrong step. Duplicate it to make a new version, or cancel their runs first.",
			);
	}
	const [row] = await db
		.update(a)
		.set({
			name: v.name ?? x.name,
			status,
			trigger: t,
			steps,
			reentry: v.reentry ?? x.reentry,
			goal_event: v.goal_event === undefined ? x.goal_event : v.goal_event || null,
			updated_at: iso(now),
		})
		.where(eq(a.id, id))
		.returning();
	// Paused: runs under way wait where they are; on again, they go on.
	return row as Automation;
}

/**
 * Whether every step of `before` is still where it was in `after`, of the same kind (a
 * condition's "no" steps too): steps changed in place or added at the end of a list are fine.
 */
export function sameShape(before: AutomationStep[], after: AutomationStep[]): boolean {
	return before.every((s, i) => {
		const t = after[i];
		if (!t || t.type !== s.type) return false;
		if (branches(s) && branches(t)) return sameShape(s.no ?? [], t.no ?? []);
		return true;
	});
}

export async function setAutomationStatus(brand: string, id: string, status: AutomationStatus) {
	return updateAutomation(brand, id, { status });
}

export async function deleteAutomation(brand: string, id: string) {
	const x = await getAutomation(brand, id);
	await db.delete(r).where(eq(r.automation_id, id));
	await db.delete(a).where(eq(a.id, id));
	return x;
}

/** The triggers that may start again for the same contact (when it's set to). */
export const REENTERS = new Set<AutomationTrigger["type"]>([
	"event",
	"email.opened",
	"email.clicked",
	"form.submitted",
	"topic.changed",
	"property.changed",
	"date",
	"inactive",
	"conversation.opened",
	"conversation.resolved",
	"conversation.rated",
]);

/** Starts it for a contact (once, unless it re-enters); the cron does the first step. */
async function start(
	x: Automation,
	contactId: string,
	data: Record<string, unknown> | null,
	now: number,
) {
	const once = !(x.reentry && REENTERS.has(x.trigger.type));
	// One statement: the check and the insert can't be split by a second trigger for the same
	// contact at the same moment (a contact added to a segment while it's created, an event sent twice).
	const res = await raw(
		`INSERT INTO automation_runs (id, automation_id, organization_id, contact_id, step, status, next_at, data, created_at, updated_at)
		SELECT ?1, ?2, ?3, ?4, 0, 'active', ?5, ?6, ?5, ?5
		WHERE ?7 = 0 OR NOT EXISTS (SELECT 1 FROM automation_runs WHERE automation_id = ?2 AND contact_id = ?4)`,
		crypto.randomUUID(),
		x.id,
		x.organization_id,
		contactId,
		iso(now),
		data === null ? null : JSON.stringify(data),
		once ? 1 : 0,
	).run();
	return (res.meta?.changes ?? 0) > 0;
}

const active = (brand: string) =>
	db
		.select()
		.from(a)
		.where(and(eq(a.organization_id, brand), eq(a.status, "active")));

export async function onContactAdded(
	brand: string,
	c: Contact,
	segments: string[],
	now = Date.now(),
) {
	for (const x of await active(brand))
		if (
			x.trigger.type === "contact.created" &&
			(!x.trigger.segment_id || segments.includes(x.trigger.segment_id))
		)
			await start(x, c.id, null, now);
}

export async function onSegmentJoined(
	brand: string,
	contactId: string,
	segmentId: string,
	now = Date.now(),
) {
	for (const x of await active(brand))
		if (x.trigger.type === "segment.joined" && x.trigger.segment_id === segmentId)
			await start(x, contactId, null, now);
}

/** The same link, give or take a trailing slash, its case of host, and the query it was sent with. */
export function sameLink(clicked: string, wanted: string) {
	const norm = (u: string) => {
		try {
			const x = new URL(u.trim());
			return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}`;
		} catch {
			return u.trim().replace(/\/+$/, "");
		}
	};
	return norm(clicked) === norm(wanted);
}

/**
 * An open or a click of a broadcast's email (src/server/events.ts): automations that start on it,
 * for the contact it went to.
 */
export async function onEngaged(
	email: { organization_id: string; broadcast_id: string | null; to: string[] },
	kind: "opened" | "clicked",
	link: string | null,
	now = Date.now(),
) {
	if (!email.broadcast_id) return 0;
	const type = kind === "opened" ? "email.opened" : "email.clicked";
	const list = (await active(email.organization_id)).filter((x) => {
		const t = x.trigger;
		if (t.type !== type) return false;
		if (t.broadcast_id && t.broadcast_id !== email.broadcast_id) return false;
		if (t.type === "email.clicked" && t.link && !(link && sameLink(link, t.link))) return false;
		return true;
	});
	if (!list.length) return 0;
	const to = email.to[0];
	if (!to) return 0;
	const address = (/<([^>]+)>/.exec(to)?.[1] ?? to).trim().toLowerCase();
	const contact = await db
		.select({ id: schema.contacts.id })
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, email.organization_id),
				eq(schema.contacts.email, address),
			),
		)
		.get();
	if (!contact) return 0;
	let started = 0;
	for (const x of list) if (await start(x, contact.id, link ? { link } : null, now)) started++;
	return started;
}

/** Starts the brand's active automations whose trigger fits, for the contact. */
async function startWhere(
	brand: string,
	contactId: string,
	fits: (t: AutomationTrigger) => boolean,
	data: Record<string, unknown> | null,
	now: number,
) {
	let started = 0;
	for (const x of await active(brand))
		if (fits(x.trigger) && (await start(x, contactId, data, now))) started++;
	return started;
}

/** Someone confirmed their sign-up on a form. */
export const onFormSubmitted = (
	brand: string,
	contactId: string,
	formId: string,
	now = Date.now(),
) =>
	startWhere(
		brand,
		contactId,
		(t) => t.type === "form.submitted" && (!t.form_id || t.form_id === formId),
		{ form_id: formId },
		now,
	);

/** A topic choice changed. */
export const onTopicChanged = (
	brand: string,
	contactId: string,
	topicId: string,
	value: "opt_in" | "opt_out",
	now = Date.now(),
) =>
	startWhere(
		brand,
		contactId,
		(t) => t.type === "topic.changed" && t.topic_id === topicId && t.value === value,
		{ topic_id: topicId, value },
		now,
	);

/** A contact changed (by the API, the dashboard, a step or a link): unsubscribing, properties. */
export async function onContactChanged(
	before: Pick<Contact, "unsubscribed" | "properties">,
	after: Contact,
	now = Date.now(),
) {
	const brand = after.organization_id;
	if (!before.unsubscribed && after.unsubscribed)
		await startWhere(brand, after.id, (t) => t.type === "unsubscribed", null, now);
	const was = before.properties ?? {};
	const is = after.properties ?? {};
	const changed = Object.keys({ ...was, ...is }).filter(
		(k) => String(was[k] ?? "") !== String(is[k] ?? ""),
	);
	for (const key of changed)
		await startWhere(
			brand,
			after.id,
			(t) =>
				t.type === "property.changed" &&
				t.key === key &&
				(!t.equals || String(is[key] ?? "").toLowerCase() === t.equals.toLowerCase()),
			{ property: key, value: is[key] ?? null, previous: was[key] ?? null },
			now,
		);
}

/**
 * A conversation started, was resolved or rated: automations on it start for its contact (the
 * brand's contact of that address; a visitor who isn't one starts nothing).
 */
export async function onConversation(
	conversationId: string,
	kind: "opened" | "resolved" | "rated",
	now = Date.now(),
) {
	const x = await db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId))
		.get();
	if (!x?.contact_address) return 0;
	const type = `conversation.${kind}` as const;
	const list = (await active(x.organization_id)).filter((y) => y.trigger.type === type);
	if (!list.length) return 0;
	const contact = await db
		.select({ id: schema.contacts.id })
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, x.organization_id),
				eq(schema.contacts.email, x.contact_address),
			),
		)
		.get();
	if (!contact) return 0;
	const fits = (t: AutomationTrigger) => {
		if (t.type === "conversation.opened")
			return (
				(!t.inbox_id || t.inbox_id === x.inbox_id) &&
				(!t.channel || t.channel === x.channel)
			);
		if (t.type === "conversation.resolved") return !t.inbox_id || t.inbox_id === x.inbox_id;
		if (t.type === "conversation.rated") {
			const n = x.csat_rating;
			if (!n) return false;
			return t.op === "at_most" ? n <= t.rating : n >= t.rating;
		}
		return false;
	};
	let started = 0;
	for (const y of list)
		if (
			fits(y.trigger) &&
			(await start(
				y,
				contact.id,
				{
					conversation_id: x.id,
					subject: x.subject ?? "",
					channel: x.channel,
					...(x.csat_rating ? { rating: x.csat_rating } : {}),
				},
				now,
			))
		)
			started++;
	return started;
}

/** The day (YYYY-MM-DD, UTC) a property's value names, if it's a date. */
export function dayOf(v: unknown): string | null {
	if (typeof v !== "string" && typeof v !== "number") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;
	const t = typeof v === "number" ? v : Date.parse(String(v));
	return Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * The cron, once a day: date triggers (a birthday, a trial's end) and "stopped engaging" ones.
 * Each starts at most once a day per contact (a yearly date once a year).
 */
export async function runDailyTriggers(now = Date.now()) {
	const list = (await db.select().from(a).where(eq(a.status, "active"))).filter(
		(x) => x.trigger.type === "date" || x.trigger.type === "inactive",
	);
	let started = 0;
	for (const x of list) {
		const t = x.trigger;
		try {
			if (t.type === "date") started += await startDates(x, t, now);
			if (t.type === "inactive") started += await startInactive(x, t.days, now);
		} catch (e) {
			console.error("automations: daily trigger failed", x.id, e);
		}
	}
	return started;
}

async function startDates(
	x: Automation,
	t: Extract<AutomationTrigger, { type: "date" }>,
	now: number,
) {
	// The property's day that makes today the day: `offset_days` after it.
	const target = new Date(now - t.offset_days * 86_400_000).toISOString().slice(0, 10);
	const path = `$."${t.key.replace(/"/g, "")}"`;
	const v = sql`substr(json_extract(${schema.contacts.properties}, ${path}), 1, 10)`;
	const rows = await db
		.select({
			id: schema.contacts.id,
			value: sql<string>`json_extract(${schema.contacts.properties}, ${path})`,
		})
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, x.organization_id),
				t.yearly ? sql`substr(${v}, 6, 5) = ${target.slice(5)}` : sql`${v} = ${target}`,
			),
		)
		.limit(5000);
	let started = 0;
	for (const c of rows) {
		if (dayOf(c.value) === null) continue;
		if (await startOnce(x, c.id, t.yearly ? 300 : null, { date: c.value }, now)) started++;
	}
	return started;
}

async function startInactive(x: Automation, days: number, now: number) {
	const e = schema.emails;
	const from = iso(now - (days + 1) * 86_400_000);
	const to = iso(now - days * 86_400_000);
	// Their last open or click fell on that day, and they got something since.
	const rows = await db
		.select({ address: e.recipient })
		.from(e)
		.where(
			and(
				eq(e.organization_id, x.organization_id),
				sql`${e.recipient} IS NOT NULL`,
				sql`coalesce(${e.clicked_at}, ${e.opened_at}) IS NOT NULL`,
			),
		)
		.groupBy(e.recipient)
		.having(
			and(
				sql`max(coalesce(${e.clicked_at}, ${e.opened_at})) >= ${from}`,
				sql`max(coalesce(${e.clicked_at}, ${e.opened_at})) < ${to}`,
			),
		)
		.limit(5000);
	let started = 0;
	for (const r0 of rows) {
		if (!r0.address) continue;
		const c = await db
			.select({ id: schema.contacts.id })
			.from(schema.contacts)
			.where(
				and(
					eq(schema.contacts.organization_id, x.organization_id),
					eq(schema.contacts.email, r0.address),
					eq(schema.contacts.unsubscribed, false),
				),
			)
			.get();
		if (c && (await startOnce(x, c.id, x.reentry ? 1 : null, { days }, now))) started++;
	}
	return started;
}

/**
 * Starts it unless the contact went through it already: ever (`withinDays` null), or in the
 * last `withinDays` days.
 */
async function startOnce(
	x: Automation,
	contactId: string,
	withinDays: number | null,
	data: Record<string, unknown>,
	now: number,
) {
	const res = await raw(
		`INSERT INTO automation_runs (id, automation_id, organization_id, contact_id, step, status, next_at, data, created_at, updated_at)
		SELECT ?1, ?2, ?3, ?4, 0, 'active', ?5, ?6, ?5, ?5
		WHERE NOT EXISTS (SELECT 1 FROM automation_runs WHERE automation_id = ?2 AND contact_id = ?4 AND (?7 IS NULL OR created_at >= ?7))`,
		crypto.randomUUID(),
		x.id,
		x.organization_id,
		contactId,
		iso(now),
		JSON.stringify(data),
		withinDays === null ? null : iso(now - withinDays * 86_400_000),
	).run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * An event came in for a contact: runs waiting for it wake up, and automations whose goal it is
 * count it (runs under way end there, as reached).
 */
async function eventArrived(brand: string, contactId: string, event: string, now: number) {
	await db
		.update(r)
		.set({ next_at: iso(now) })
		.where(
			and(
				eq(r.contact_id, contactId),
				eq(r.status, "active"),
				eq(r.waiting_for, event),
				eq(r.organization_id, brand),
			),
		);
	const goals = await db
		.select({ id: a.id })
		.from(a)
		.where(and(eq(a.organization_id, brand), eq(a.goal_event, event)));
	if (!goals.length) return;
	const ids = goals.map((g) => g.id);
	// Within 30 days of starting: a run that finished counts too.
	await db
		.update(r)
		.set({ converted_at: iso(now) })
		.where(
			and(
				inArray(r.automation_id, ids),
				eq(r.contact_id, contactId),
				isNull(r.converted_at),
				sql`${r.created_at} >= ${iso(now - 30 * 86_400_000)}`,
			),
		);
	await db
		.update(r)
		.set({
			status: "done",
			next_at: null,
			waiting_for: null,
			waiting_since: null,
			locked_until: null,
			updated_at: iso(now),
		})
		.where(
			and(inArray(r.automation_id, ids), eq(r.contact_id, contactId), eq(r.status, "active")),
		);
}

export const eventInput = z.object({
	event: z.string().regex(EVENT_NAME, "event: letters, numbers, _ . : and - (up to 100)"),
	email: z.string().max(320).optional(),
	contact_id: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
	/** A purchase's amount (also read from data.value, data.revenue or data.total). */
	value: z.number().min(0).max(1e9).optional(),
	/** Its ISO currency code (also data.currency). */
	currency: z
		.string()
		.regex(/^[A-Za-z]{3}$/, "currency: a 3-letter code like USD")
		.optional(),
	/** Add the contact when the address isn't one yet (the default). */
	create_contact: z.boolean().optional(),
});

/**
 * An app's event about a contact (or Mailroom's own: a poll answered, a referral milestone):
 * kept on the contact, and automations waiting for it start.
 */
export async function recordEvent(
	brand: string,
	raw: unknown,
	now = Date.now(),
	source: EventSource = "api",
) {
	const v = eventInput.parse(raw);
	if (!v.email && !v.contact_id) throw validation("Give the contact's email or contact_id");
	let contact: Contact | null = await getContact(
		brand,
		(v.contact_id ?? v.email) as string,
	).catch(() => null);
	if (!contact) {
		if (!v.email || v.create_contact === false) throw notFound("Contact");
		contact = (await upsertContact(brand, { email: v.email, source: "event" }, now)).contact;
	}
	const data = v.data ? boundedData(v.data) : null;
	// A purchase: the last broadcast, automation email or chat that reached them gets the credit.
	const { creditFor, purchaseOf } = await import("./revenue");
	const purchase = purchaseOf({ value: v.value, currency: v.currency, data });
	const credit = purchase ? await creditFor(brand, contact.email, now) : null;
	const stored = await storeEvent(
		brand,
		contact.id,
		v.event,
		data,
		source,
		now,
		purchase ? { ...purchase, credit } : null,
	);
	await eventArrived(brand, contact.id, v.event, now);
	let started = 0;
	for (const x of await active(brand))
		if (x.trigger.type === "event" && x.trigger.event === v.event)
			if (await start(x, contact.id, data, now)) started++;
	return {
		object: "event",
		id: stored.id,
		event: v.event,
		contact_id: contact.id,
		started,
		...(purchase
			? {
					value: purchase.value,
					currency: purchase.currency,
					credit: credit ? { type: credit.type, id: credit.id } : null,
				}
			: {}),
	};
}

/** The event's data, cut to 16 KB: whole keys are dropped from the end, never cut mid-value. */
function boundedData(data: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	let size = 2;
	for (const [k, x] of Object.entries(data)) {
		const piece = JSON.stringify({ [k]: x }).length;
		if (size + piece > 16_000) break;
		out[k] = x;
		size += piece;
	}
	return out;
}

/** Claims the runs due now (a run left by a cron that died is claimable again). */
async function claim(now: number) {
	const due = db
		.select({ id: r.id })
		.from(r)
		.innerJoin(a, eq(a.id, r.automation_id))
		.where(
			and(
				eq(r.status, "active"),
				eq(a.status, "active"),
				lte(r.next_at, iso(now)),
				or(isNull(r.locked_until), lt(r.locked_until, iso(now))),
			),
		)
		.orderBy(asc(r.next_at))
		.limit(RUNS_PER_MINUTE);
	// Safe to repeat after a transient D1 error: runs the first try did lock aren't taken again
	// (they're locked now), so they just wait for the lock to pass, as after a Worker that died.
	return retrying(() =>
		db
			.update(r)
			.set({ locked_until: iso(now + CLAIM_MS) })
			.where(
				and(inArray(r.id, due), or(isNull(r.locked_until), lt(r.locked_until, iso(now)))),
			)
			.returning(),
	);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The run's next email: the template filled in with the contact's and the event's values. */
async function sendStep(
	x: Automation,
	run: AutomationRun,
	contact: Contact,
	s: Extract<AutomationStep, { type: "send" }>,
) {
	const org = await orgOf(x.organization_id);
	const t = await getTemplate(org, s.template_id);
	if (!t.published) throw new Error(`The template ${t.name} isn't published`);
	const p = t.published;
	const own = variableValues(p.variables, s.variables ?? {}, "variables");
	const event: Record<string, string | number> = {};
	for (const [k, v] of Object.entries(run.data ?? {}))
		if (typeof v === "string" || typeof v === "number") event[`event.${k}`] = v;
	const values = { ...(await contactValues(x.organization_id, contact)), ...event, ...own };
	const escaped = Object.fromEntries(
		Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? escapeHtml(v) : v]),
	);
	const html = fill(p.html, escaped);
	const text = p.text === "" ? undefined : p.text ? fill(p.text, values) : htmlToText(html);
	const input = parseSend({
		from: s.from || p.from,
		to: contact.email,
		subject: fill(s.subject || p.subject || "", values),
		reply_to: p.reply_to ?? undefined,
		html,
		text,
		unsubscribe_group: ALL_BROADCASTS_GROUP,
		template_id: t.id,
		tags: [{ name: "automation", value: x.id }],
	});
	const { kickDispatcher } = await import("./dispatcher");
	const [res] = await createEmails(x.organization_id, [input], {
		source: "automation",
		queue: true,
		kick: kickDispatcher,
	});
	if (res?.error) throw res.error;
	return res?.id ?? null;
}

async function holds(
	run: AutomationRun,
	contact: Contact,
	s: Extract<AutomationStep, { type: "condition" }>,
) {
	if (s.segment_id) {
		const inIt = await db
			.select({ id: schema.contactSegments.contact_id })
			.from(schema.contactSegments)
			.where(
				and(
					eq(schema.contactSegments.contact_id, contact.id),
					eq(schema.contactSegments.segment_id, s.segment_id),
				),
			)
			.get();
		if (!inIt) return false;
	}
	if (s.property) {
		const v = contact.properties?.[s.property];
		if (s.equals === null || s.equals === undefined) {
			if (v === undefined || v === null || v === "") return false;
		} else if (String(v ?? "") !== String(s.equals)) return false;
	}
	if (s.engaged) {
		if (!run.last_email_id) return false;
		const e = await db
			.select({ opened: schema.emails.opened_at, clicked: schema.emails.clicked_at })
			.from(schema.emails)
			.where(eq(schema.emails.id, run.last_email_id))
			.get();
		if (!(s.engaged === "clicked" ? e?.clicked : e?.opened || e?.clicked)) return false;
	}
	return true;
}

/** The steps a run's place is in (a condition's "no" steps, or the top level). */
export function stepsAt(steps: AutomationStep[], path: number[]): AutomationStep[] | null {
	let list = steps;
	for (const i of path.slice(0, -1)) {
		const s = list[i];
		if (!branches(s) || !s.no) return null;
		list = s.no;
	}
	return list;
}

/** The steps that do one thing for the contact and go on. */
type ActStep = Extract<
	AutomationStep,
	{
		type:
			| "segment"
			| "property"
			| "notify"
			| "conversation"
			| "topic"
			| "newsletter"
			| "webhook"
			| "score";
	}
>;
const ACTS = new Set<AutomationStep["type"]>([
	"segment",
	"property",
	"notify",
	"conversation",
	"topic",
	"newsletter",
	"webhook",
	"score",
]);
const isAct = (s: AutomationStep): s is ActStep => ACTS.has(s.type);

/**
 * From a conversation's person panel (or the assistant): put someone in a segment, subscribe them
 * to a newsletter, or start an automation for them. Not a contact yet: they become one first
 * (source "conversation"). Returns the contact and, for an automation, whether it started.
 */
export async function actForPerson(
	brand: string,
	address: string,
	v:
		| { type: "contact" }
		| { type: "segment"; segment_id: string; action: "add" | "remove" }
		| { type: "newsletter"; newsletter_id: string; action: "subscribe" | "unsubscribe" }
		| { type: "automation"; automation_id: string },
	now = Date.now(),
) {
	const { upsertContact, segmentOf } = await import("./contacts");
	const email = address.trim().toLowerCase();
	if (!email.includes("@")) throw validation("That conversation has no email address");
	let contact = await db
		.select()
		.from(schema.contacts)
		.where(and(eq(schema.contacts.organization_id, brand), eq(schema.contacts.email, email)))
		.get();
	if (!contact)
		contact = (await upsertContact(brand, { email, source: "conversation" }, now)).contact;
	if (v.type === "contact") return { contact_id: contact.id, started: null };
	if (v.type === "automation") {
		const x = await getAutomation(brand, v.automation_id);
		if (x.status !== "active") throw validation("Turn the automation on first");
		return { contact_id: contact.id, started: await start(x, contact.id, null, now) };
	}
	if (v.type === "segment") {
		const seg = await segmentOf(brand, v.segment_id);
		if (seg.rules) throw validation("A live segment picks its people by its rules");
	}
	const fake = { organization_id: brand } as Automation;
	await actStep(fake, {} as AutomationRun, contact as Contact, v as ActStep, now);
	return { contact_id: contact.id, started: null };
}

/** Does one of those steps for the contact. */
async function actStep(
	x: Automation,
	run: AutomationRun,
	contact: Contact,
	s: ActStep,
	now: number,
) {
	const brand = x.organization_id;
	const { addToSegment, removeFromSegment, updateContact, setTopics } = await import(
		"./contacts"
	);
	switch (s.type) {
		case "segment":
			if (s.action === "add") await addToSegment(brand, contact.id, s.segment_id, now);
			else await removeFromSegment(brand, contact.id, s.segment_id);
			return;
		case "property":
			await updateContact(brand, contact.id, { properties: { [s.key]: s.value } }, now);
			return;
		case "score": {
			const was = Number(contact.properties?.[s.key] ?? 0);
			const value = (Number.isFinite(was) ? was : 0) + s.add;
			await updateContact(brand, contact.id, { properties: { [s.key]: value } }, now);
			return;
		}
		case "topic":
			await setTopics(brand, contact.id, [{ id: s.topic_id, subscription: s.value }], now);
			return;
		case "newsletter": {
			const n = await db
				.select()
				.from(schema.newsletters)
				.where(
					and(
						eq(schema.newsletters.id, s.newsletter_id),
						eq(schema.newsletters.organization_id, brand),
					),
				)
				.get();
			if (!n) throw new Error("The newsletter was deleted");
			if (n.segment_id) {
				const seg = await segmentOf(brand, n.segment_id).catch(() => null);
				if (seg && !seg.rules) {
					if (s.action === "subscribe")
						await addToSegment(brand, contact.id, n.segment_id, now);
					else await removeFromSegment(brand, contact.id, n.segment_id);
				}
			}
			if (n.topic_id)
				await setTopics(
					brand,
					contact.id,
					[
						{
							id: n.topic_id,
							subscription: s.action === "subscribe" ? "opt_in" : "opt_out",
						},
					],
					now,
				);
			return;
		}
		case "notify":
			await notifyTeam(x, run, contact, s);
			return;
		case "conversation":
			await conversationStep(brand, contact, s, now);
			return;
		case "webhook":
			await callWebhook(x, run, contact, s.url, now);
			return;
	}
}

/** What the automation page picks from beyond segments and templates. */
export async function automationOptions(brand: string) {
	const org = await orgOf(brand);
	const { member, user } = await import("./db/auth-schema");
	const { eventNames } = await import("./contact-events");
	const own = <T extends { organization_id: unknown }>(t: T) =>
		eq(t.organization_id as never, brand);
	const [forms, newsletters, inboxes, team, events] = await Promise.all([
		db
			.select({ id: schema.signupForms.id, name: schema.signupForms.name })
			.from(schema.signupForms)
			.where(own(schema.signupForms)),
		db
			.select({ id: schema.newsletters.id, name: schema.newsletters.name })
			.from(schema.newsletters)
			.where(own(schema.newsletters)),
		db
			.select({ id: schema.inboxes.id, name: schema.inboxes.name })
			.from(schema.inboxes)
			.where(own(schema.inboxes)),
		db
			.select({ id: user.id, name: user.name, email: user.email })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(eq(member.organizationId, org)),
		eventNames(brand),
	]);
	return { forms, newsletters, inboxes, team, events };
}

/** The team's addresses among `to`: only members of the brand's organization get it. */
async function teamAddresses(brand: string, to: string[]) {
	const org = await orgOf(brand);
	const { member, user } = await import("./db/auth-schema");
	const rows = await db
		.select({ email: user.email })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(eq(member.organizationId, org));
	const team = new Set(rows.map((r) => r.email.toLowerCase()));
	return to.filter((t) => team.has(t.toLowerCase()));
}

async function notifyTeam(
	x: Automation,
	run: AutomationRun,
	contact: Contact,
	s: Extract<AutomationStep, { type: "notify" }>,
) {
	const to = await teamAddresses(x.organization_id, s.to);
	if (!to.length) return;
	const values = await runValues(x, run, contact);
	const { sendSystemEmail, systemLayout } = await import("./system-email");
	const { baseUrl } = await import("./env");
	const subject = `${x.name}: ${contact.email}`;
	const body = systemLayout({
		title: subject,
		lines: fill(s.message, values).split(/\n+/).filter(Boolean),
		button: { label: "Open the contact", url: `${baseUrl()}/contacts/${contact.id}` },
	});
	for (const address of to) await sendSystemEmail({ to: address, subject, ...body });
}

/** The contact's latest open conversation gets the step: tagged, prioritized, assigned or resolved. */
async function conversationStep(
	brand: string,
	contact: Contact,
	s: Extract<AutomationStep, { type: "conversation" }>,
	now: number,
) {
	const cv = schema.conversations;
	const x = await db
		.select()
		.from(cv)
		.where(
			and(
				eq(cv.organization_id, brand),
				eq(cv.contact_address, contact.email.toLowerCase()),
				eq(cv.status, "open"),
			),
		)
		.orderBy(desc(cv.last_message_at))
		.get();
	if (!x) return;
	const at = iso(now);
	if (s.action === "tag") {
		const tags = [...new Set([...(x.tags ?? []), (s.value ?? "").toLowerCase()])].filter(
			Boolean,
		);
		await db.update(cv).set({ tags, updated_at: at }).where(eq(cv.id, x.id));
	} else if (s.action === "priority")
		await db
			.update(cv)
			.set({ priority: s.value ?? "normal", updated_at: at })
			.where(eq(cv.id, x.id));
	else if (s.action === "assign") {
		const { user } = await import("./db/auth-schema");
		const u = await db
			.select({ id: user.id, name: user.name, email: user.email })
			.from(user)
			.where(eq(user.id, s.value ?? ""))
			.get();
		if (!u) return;
		await db
			.update(cv)
			.set({
				assignee: `user:${u.id}`,
				assignee_name: u.name || u.email,
				claimed_until: null,
				updated_at: at,
			})
			.where(eq(cv.id, x.id));
	} else
		await db
			.update(cv)
			.set({ status: "resolved", resolved_at: at, updated_at: at })
			.where(eq(cv.id, x.id));
}

/** Posts the contact and the run's event data to the step's URL; a refusal fails the run. */
async function callWebhook(
	x: Automation,
	run: AutomationRun,
	contact: Contact,
	url: string,
	now: number,
) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": "Mailroom-Automations" },
		body: JSON.stringify({
			type: "automation.step",
			created_at: iso(now),
			automation: { id: x.id, name: x.name },
			run_id: run.id,
			contact: {
				id: contact.id,
				email: contact.email,
				first_name: contact.first_name,
				last_name: contact.last_name,
				properties: contact.properties ?? {},
			},
			data: run.data ?? null,
		}),
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	if (res.status < 200 || res.status >= 300)
		throw new Error(`The webhook answered ${res.status}`);
}

/** The values a run's emails are filled in with: the contact's and the event's. */
async function runValues(x: Automation, run: AutomationRun, contact: Contact) {
	const event: Record<string, string | number> = {};
	for (const [k, v] of Object.entries(run.data ?? {}))
		if (typeof v === "string" || typeof v === "number") event[`event.${k}`] = v;
	return { ...(await contactValues(x.organization_id, contact)), ...event };
}

/** A short email written in the step: its paragraphs, filled in, with the unsubscribe link. */
async function emailStep(
	x: Automation,
	run: AutomationRun,
	contact: Contact,
	s: Extract<AutomationStep, { type: "email" }>,
) {
	const values = await runValues(x, run, contact);
	const text = fill(s.body, values);
	const html = `<!doctype html><html><body style="margin:0;padding:24px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c1c1a"><div style="max-width:560px;margin:0 auto">${text
		.split(/\n{2,}/)
		.map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("")}</div></body></html>`;
	const input = parseSend({
		from: s.from,
		to: contact.email,
		subject: fill(s.subject, values),
		html,
		text,
		unsubscribe_group: ALL_BROADCASTS_GROUP,
		tags: [{ name: "automation", value: x.id }],
	});
	const { kickDispatcher } = await import("./dispatcher");
	const [res] = await createEmails(x.organization_id, [input], {
		source: "automation",
		queue: true,
		kick: kickDispatcher,
	});
	if (res?.error) throw res.error;
	return res?.id ?? null;
}

/** The same contact and run always take the same side of a split. */
export function splitSide(runId: string, path: number[], percent: number) {
	let h = 7;
	for (const ch of `${runId}:${path.join(".")}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h % 100 < percent;
}

/**
 * Extends the run's claim if it's still the one this cron holds (and the run still active);
 * false when a cancel or another cron took it meanwhile. `run.locked_until` follows.
 */
async function renewClaim(run: AutomationRun, now: number) {
	const until = iso(Math.max(Date.now(), now) + CLAIM_MS);
	const kept = await db
		.update(r)
		.set({ locked_until: until })
		.where(
			and(
				eq(r.id, run.id),
				eq(r.status, "active"),
				run.locked_until ? eq(r.locked_until, run.locked_until) : isNull(r.locked_until),
			),
		)
		.returning({ id: r.id });
	if (!kept.length) return false;
	run.locked_until = until;
	return true;
}

/** Quiet mode holds this person out of the automation's emails now (they're skipped). */
async function quietNow(x: Automation, contact: Contact, now: number) {
	// They paused email from their preferences page.
	if (contact.paused_until && contact.paused_until > iso(now)) return true;
	const { automationHold } = await import("./marketing-rules");
	return (await automationHold(x.organization_id, contact.email, now)) !== null;
}

/** Moves one run on: steps until a wait or the end. */
async function advance(x: Automation, run: AutomationRun, now: number) {
	const set: Partial<AutomationRun> = { locked_until: null, updated_at: iso(now) };
	// Where it got to, kept even when a later step fails (its emails sent are recorded).
	let path = run.path?.length ? [...run.path] : [run.step];
	let lastEmail = run.last_email_id;
	let waitingFor = run.waiting_for;
	let waitingSince = run.waiting_since;
	try {
		const contact = await db
			.select()
			.from(schema.contacts)
			.where(
				and(
					eq(schema.contacts.id, run.contact_id),
					eq(schema.contacts.organization_id, run.organization_id),
				),
			)
			.get();
		let status: AutomationRun["status"] = "active";
		let nextAt: string | null = iso(now);
		let error: string | null = null;
		if (!contact) {
			status = "exited";
			error = "The contact was deleted";
		}
		const next = () => {
			path = [...path.slice(0, -1), (path.at(-1) ?? 0) + 1];
		};
		for (let n = 0; status === "active" && n < STEPS_PER_GO; n++) {
			// The end of any list of steps (the "no" steps too) is the end of the run.
			const s = stepsAt(x.steps, path)?.[path.at(-1) ?? 0];
			if (!s) {
				status = "done";
				nextAt = null;
				break;
			}
			if (s.type === "wait") {
				next();
				nextAt = iso(now + s.minutes * 60_000);
				break;
			}
			if (s.type === "send") {
				if (contact?.unsubscribed) {
					status = "exited";
					error = "The contact unsubscribed";
					break;
				}
				// Still this claim's (renewed): one that ran out was taken by another cron, which sends it.
				if (!(await renewClaim(run, now))) return;
				if (await quietNow(x, contact as Contact, now)) {
					next();
					continue;
				}
				lastEmail = await sendStep(
					x,
					{ ...run, last_email_id: lastEmail },
					contact as Contact,
					s,
				);
				next();
				continue;
			}
			if (s.type === "email") {
				if (contact?.unsubscribed) {
					status = "exited";
					error = "The contact unsubscribed";
					break;
				}
				if (!(await renewClaim(run, now))) return;
				// Quiet mode: someone with an urgent conversation or a low rating skips this email.
				if (!(await quietNow(x, contact as Contact, now)))
					lastEmail = await emailStep(x, run, contact as Contact, s);
				next();
				continue;
			}
			if (isAct(s)) {
				await actStep(x, run, contact as Contact, s, now);
				next();
				continue;
			}
			let yes: boolean;
			if (s.type === "wait_event") {
				if (!waitingSince) {
					// Starts waiting: an event wakes it sooner (recordEvent), or the time runs out.
					waitingFor = s.event;
					waitingSince = iso(now);
					nextAt = iso(now + s.minutes * 60_000);
					break;
				}
				const did = await db
					.select({ id: schema.contactEvents.id })
					.from(schema.contactEvents)
					.where(
						and(
							eq(schema.contactEvents.contact_id, run.contact_id),
							eq(schema.contactEvents.name, s.event),
							sql`${schema.contactEvents.created_at} >= ${waitingSince}`,
						),
					)
					.get();
				waitingFor = null;
				waitingSince = null;
				yes = !!did;
			} else if (s.type === "split") yes = splitSide(run.id, path, s.percent);
			else yes = await holds({ ...run, last_email_id: lastEmail }, contact as Contact, s);
			if (yes) next();
			else if (s.no?.length) path = [...path, 0];
			else {
				status = "exited";
				error = null;
				break;
			}
		}
		Object.assign(set, {
			step: path[0] ?? 0,
			path: path.length > 1 ? path : null,
			status,
			next_at: status === "active" ? nextAt : null,
			last_email_id: lastEmail,
			waiting_for: status === "active" ? waitingFor : null,
			waiting_since: status === "active" ? waitingSince : null,
			error,
		});
	} catch (e) {
		console.error("automations: run failed", run.id, e);
		Object.assign(set, {
			// The step it failed at, and the last email it did send: nothing is sent twice if it's
			// looked at again.
			step: path[0] ?? 0,
			path: path.length > 1 ? path : null,
			last_email_id: lastEmail,
			status: "failed",
			next_at: null,
			error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
		});
	}
	// Only if it's still this claim's: a cancel in between stays canceled, and a run another
	// cron took over (this one ran past its claim) isn't moved twice.
	await db
		.update(r)
		.set(set)
		.where(
			and(
				eq(r.id, run.id),
				eq(r.status, "active"),
				run.locked_until ? eq(r.locked_until, run.locked_until) : isNull(r.locked_until),
			),
		);
}

/** The cron's turn: runs due move on. Returns how many. */
export async function runAutomations(now = Date.now()) {
	const runs = await claim(now);
	if (!runs.length) return 0;
	const ids = [...new Set(runs.map((x) => x.automation_id))];
	const byId = new Map(
		(await db.select().from(a).where(inArray(a.id, ids))).map((x) => [x.id, x]),
	);
	for (const run of runs) {
		const x = byId.get(run.automation_id);
		if (x) await advance(x, run, now);
	}
	return runs.length;
}

/** Ends a contact's runs under way (by hand). */
export async function cancelRun(brand: string, runId: string, now = Date.now()) {
	const [row] = await db
		.update(r)
		.set({ status: "canceled", next_at: null, updated_at: iso(now) })
		.where(and(eq(r.id, runId), eq(r.organization_id, brand), eq(r.status, "active")))
		.returning();
	if (!row) throw new ApiError(409, "not_active", "This run isn't under way");
	return row;
}

/** How many runs are in each state, and the latest ones with their contacts. */
export async function automationRuns(id: string, limit = 50) {
	const [counts, latest, here] = await Promise.all([
		db
			.select({ status: r.status, n: sql<number>`COUNT(*)` })
			.from(r)
			.where(eq(r.automation_id, id))
			.groupBy(r.status),
		db
			.select({
				id: r.id,
				status: r.status,
				step: r.step,
				path: r.path,
				next_at: r.next_at,
				error: r.error,
				created_at: r.created_at,
				updated_at: r.updated_at,
				contact_id: r.contact_id,
				email: schema.contacts.email,
			})
			.from(r)
			.leftJoin(
				schema.contacts,
				and(
					eq(schema.contacts.id, r.contact_id),
					eq(schema.contacts.organization_id, r.organization_id),
				),
			)
			.where(eq(r.automation_id, id))
			.orderBy(desc(r.created_at))
			.limit(limit),
		// Where the runs under way are (the step each does next), for the canvas.
		limit
			? db
					.select({ step: r.step, path: r.path, n: sql<number>`COUNT(*)` })
					.from(r)
					.where(and(eq(r.automation_id, id), eq(r.status, "active")))
					.groupBy(r.step, r.path)
			: Promise.resolve([]),
	]);
	const by: Record<string, number> = { active: 0, done: 0, exited: 0, failed: 0, canceled: 0 };
	for (const c of counts) by[c.status] = Number(c.n);
	const reached = await db
		.select({ n: sql<number>`COUNT(*)` })
		.from(r)
		.where(and(eq(r.automation_id, id), sql`${r.converted_at} IS NOT NULL`))
		.get();
	by.converted = Number(reached?.n ?? 0);
	return {
		counts: by,
		runs: latest,
		here: here.map((h) => ({ path: h.path?.length ? h.path : [h.step], n: Number(h.n) })),
	};
}
