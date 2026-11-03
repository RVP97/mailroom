import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { fill, htmlToText } from "../lib/template-fill";
import { orgOf } from "./brands";
import {
	ALL_BROADCASTS_GROUP,
	type Contact,
	contactValues,
	getContact,
	segmentOf,
	upsertContact,
} from "./contacts";
import { db, schema } from "./db";
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
]);

/** Steps in all, counting each condition's "no" steps, and how deep conditions may nest. */
const MAX_STEPS = 40;
const MAX_DEPTH = 4;

type StepIn = z.input<typeof leaf> | (z.input<typeof conditionStep> & { no?: StepIn[] | null });
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
		key: z.string().trim().min(1).max(100),
		value: z.union([z.string().max(2000), z.number()]),
	}),
]);

const step: z.ZodType<StepIn> = z.lazy(() =>
	z.union([leaf, conditionStep.extend({ no: z.array(step).nullish() })]),
);

export const automationInput = z.object({
	name: z.string().trim().min(1).max(200),
	status: z.enum(["draft", "active", "paused"]).optional(),
	trigger,
	steps: z.array(step).max(MAX_STEPS),
	reentry: z.boolean().optional(),
});

/** Every step, the "no" steps of conditions too. */
export function eachStep(steps: AutomationStep[], at: number[] = []): [AutomationStep, number[]][] {
	return steps.flatMap((s, i) => [
		[s, [...at, i]] as [AutomationStep, number[]],
		...(s.type === "condition" && s.no ? eachStep(s.no, [...at, i]) : []),
	]);
}

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
		const minutes = Math.round(
			(s.minutes ?? 0) + (s.hours ?? 0) * 60 + (s.days ?? 0) * 24 * 60,
		);
		if (minutes < 1) throw validation("A wait step needs minutes, hours or days");
		return { type: "wait", minutes: Math.min(minutes, MAX_WAIT_MINUTES) };
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
		...(s.no?.length ? { no: normalizeAll(s.no, depth + 1) } : {}),
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
		if ((s.type === "condition" || s.type === "segment") && s.segment_id)
			await segmentOf(brand, s.segment_id);
	}
	if (!eachStep(steps).some(([s]) => s.type === "send"))
		throw validation("Add a step that sends an email before turning it on");
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
	const [row] = await db
		.update(a)
		.set({
			name: v.name ?? x.name,
			status,
			trigger: t,
			steps,
			reentry: v.reentry ?? x.reentry,
			updated_at: iso(now),
		})
		.where(eq(a.id, id))
		.returning();
	// Paused: runs under way wait where they are; on again, they go on.
	return row as Automation;
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
]);

/** Starts it for a contact (once, unless it re-enters); the cron does the first step. */
async function start(
	x: Automation,
	contactId: string,
	data: Record<string, unknown> | null,
	now: number,
) {
	if (!(x.reentry && REENTERS.has(x.trigger.type))) {
		const before = await db
			.select({ id: r.id })
			.from(r)
			.where(and(eq(r.automation_id, x.id), eq(r.contact_id, contactId)))
			.get();
		if (before) return false;
	}
	await db.insert(r).values({
		id: crypto.randomUUID(),
		automation_id: x.id,
		organization_id: x.organization_id,
		contact_id: contactId,
		step: 0,
		status: "active",
		next_at: iso(now),
		data,
		created_at: iso(now),
		updated_at: iso(now),
	});
	return true;
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

export const eventInput = z.object({
	event: z.string().regex(EVENT_NAME, "event: letters, numbers, _ . : and - (up to 100)"),
	email: z.string().max(320).optional(),
	contact_id: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
	/** Add the contact when the address isn't one yet (the default). */
	create_contact: z.boolean().optional(),
});

/** An app's event about a contact: automations waiting for it start. */
export async function recordEvent(brand: string, raw: unknown, now = Date.now()) {
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
	const data = v.data ? JSON.parse(JSON.stringify(v.data).slice(0, 16_000) || "{}") : null;
	let started = 0;
	for (const x of await active(brand))
		if (x.trigger.type === "event" && x.trigger.event === v.event)
			if (await start(x, contact.id, data, now)) started++;
	return { object: "event", event: v.event, contact_id: contact.id, started };
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
	return db
		.update(r)
		.set({ locked_until: iso(now + CLAIM_MS) })
		.where(and(inArray(r.id, due), or(isNull(r.locked_until), lt(r.locked_until, iso(now)))))
		.returning();
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
		if (s?.type !== "condition" || !s.no) return null;
		list = s.no;
	}
	return list;
}

/** Does a segment or property step for the contact. */
async function actStep(
	x: Automation,
	contact: Contact,
	s: Extract<AutomationStep, { type: "segment" | "property" }>,
	now: number,
) {
	const { addToSegment, removeFromSegment, updateContact } = await import("./contacts");
	if (s.type === "segment") {
		if (s.action === "add")
			await addToSegment(x.organization_id, contact.id, s.segment_id, now);
		else await removeFromSegment(x.organization_id, contact.id, s.segment_id);
		return;
	}
	await updateContact(x.organization_id, contact.id, { properties: { [s.key]: s.value } }, now);
}

/** Moves one run on: steps until a wait or the end. */
async function advance(x: Automation, run: AutomationRun, now: number) {
	const set: Partial<AutomationRun> = { locked_until: null, updated_at: iso(now) };
	try {
		const contact = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.id, run.contact_id))
			.get();
		let path = run.path?.length ? [...run.path] : [run.step];
		let lastEmail = run.last_email_id;
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
				lastEmail = await sendStep(
					x,
					{ ...run, last_email_id: lastEmail },
					contact as Contact,
					s,
				);
				next();
				continue;
			}
			if (s.type === "segment" || s.type === "property") {
				await actStep(x, contact as Contact, s, now);
				next();
				continue;
			}
			if (await holds({ ...run, last_email_id: lastEmail }, contact as Contact, s)) next();
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
			error,
		});
	} catch (e) {
		console.error("automations: run failed", run.id, e);
		Object.assign(set, {
			status: "failed",
			next_at: null,
			error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
		});
	}
	await db.update(r).set(set).where(eq(r.id, run.id));
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
			.leftJoin(schema.contacts, eq(schema.contacts.id, r.contact_id))
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
	return {
		counts: by,
		runs: latest,
		here: here.map((h) => ({ path: h.path?.length ? h.path : [h.step], n: Number(h.n) })),
	};
}
