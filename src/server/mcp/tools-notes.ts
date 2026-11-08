import { z } from "zod";
import {
	addContactNote,
	contactNotes,
	deleteContactNote,
	openFollowUps,
	updateContactNote,
} from "../contact-notes";
import { getContact } from "../contacts";
import { ApiError } from "../errors";
import {
	brandOf,
	brandsOf,
	forbidden,
	logged,
	oneBrand,
	orgAt,
	organization,
	type Tool,
} from "./kit";
import type { McpContext, Membership } from "./tools";

/** Notes are for people who edit contacts or answer them in the inbox. */
function mayNote(org: Membership) {
	if (!org.access.can("contacts:edit") && !org.access.can("inbox:reply"))
		throw forbidden(org, "contacts:edit");
}

const authorOf = (ctx: McpContext) => ({
	type: "person" as const,
	id: ctx.userId,
	name: ctx.email,
});

/** Notes and follow-ups on contacts (the contact page's Notes & follow-ups card). */
export const NOTE_TOOLS: Tool[] = [
	{
		name: "list_contact_notes",
		title: "A contact's notes",
		description:
			"Everything the team wrote about a contact (by id or address): its open follow-ups (soonest due first), its notes and done follow-ups, and the notes left on the brand's conversations with them.",
		input: { organization, brand: oneBrand, contact: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const brand = await brandOf(org.id, a.brand);
			const c = await getContact(brand, a.contact as string);
			return { contact_id: c.id, email: c.email, ...(await contactNotes(brand, c)) };
		},
	},
	{
		name: "save_contact_note",
		title: "Add or change a contact note",
		description:
			"Adds a note to a contact (contact: id or address), or changes one (id). due_at (ISO time, or YYYY-MM-DD for 9:00 UTC that day) makes it a follow-up for assignee_id (a member's user id from list_team; default you); due_at null turns it back into a plain note. done: true finishes a follow-up, false reopens it. Needs contacts:edit or inbox:reply.",
		input: {
			organization,
			brand: oneBrand,
			contact: z.string().optional(),
			id: z.string().optional(),
			text: z.string().optional(),
			due_at: z.string().nullable().optional(),
			assignee_id: z.string().nullable().optional(),
			done: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			mayNote(org);
			const brand = await brandOf(org.id, a.brand);
			const input = {
				text: a.text as string | undefined,
				due_at: a.due_at as string | null | undefined,
				assignee_id: a.assignee_id as string | null | undefined,
				done: a.done as boolean | undefined,
			};
			if (a.id) {
				const note = await updateContactNote({
					organizationId: org.id,
					brand,
					id: a.id as string,
					author: authorOf(ctx),
					input: Object.fromEntries(
						Object.entries(input).filter(([, v]) => v !== undefined),
					),
				});
				const c = await getContact(brand, note.contact_id);
				await logged(ctx, org, a.done ? "contact_note.done" : "contact_note.edited", {
					type: "contact",
					id: c.id,
					name: c.email,
				});
				return note;
			}
			if (!a.contact)
				throw new ApiError(
					422,
					"validation_error",
					"Name the contact (id or address), or a note's id",
				);
			const c = await getContact(brand, a.contact as string);
			const note = await addContactNote({
				organizationId: org.id,
				brand,
				contactId: c.id,
				author: authorOf(ctx),
				input: { ...input, text: input.text ?? "" },
			});
			await logged(
				ctx,
				org,
				note.kind === "follow_up" ? "contact_note.follow_up" : "contact_note.added",
				{ type: "contact", id: c.id, name: c.email },
			);
			return note;
		},
	},
	{
		name: "delete_contact_note",
		title: "Delete a contact note",
		description: "Deletes one of a contact's notes or follow-ups (by its id).",
		input: { organization, brand: oneBrand, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			mayNote(org);
			const brand = await brandOf(org.id, a.brand);
			const row = await deleteContactNote(brand, a.id as string);
			const c = await getContact(brand, row.contact_id).catch(() => null);
			await logged(ctx, org, "contact_note.deleted", {
				type: "contact",
				id: row.contact_id,
				name: c?.email ?? "a contact",
			});
			return { deleted: true, id: row.id };
		},
	},
	{
		name: "list_follow_ups",
		title: "Open follow-ups",
		description:
			"Open follow-ups on contacts across the organization's brands (or one brand), soonest due first, each with its contact. mine: true (default) only yours; false everyone's. due_by (ISO time) only those due by then.",
		input: {
			organization,
			brand: z.string().optional(),
			mine: z.boolean().optional(),
			due_by: z.string().optional(),
			limit: z.number().int().min(1).max(200).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			return {
				follow_ups: await openFollowUps({
					brands: await brandsOf(org.id, a.brand),
					assignee: a.mine === false ? null : ctx.userId,
					dueBy: (a.due_by as string | undefined) ?? null,
					limit: a.limit as number | undefined,
				}),
			};
		},
	},
];
