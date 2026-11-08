import { describe, expect, it } from "vitest";
import {
	addContactNote,
	contactNotes,
	contactNoteSummary,
	deleteContactNote,
	openFollowUps,
	updateContactNote,
} from "@/server/contact-notes";
import { db, schema } from "@/server/db";
import { iso } from "@/server/time";
import { personPanel } from "@/server/timeline";
import { today } from "@/server/today";
import { seedOrg, uid } from "./helpers";

async function member(org: string, name: string) {
	const id = `user_${uid()}`;
	await db.insert(schema.user).values({ id, name, email: `${id}@p.test` });
	await db.insert(schema.member).values({
		id: `mem_${uid()}`,
		organizationId: org,
		userId: id,
		role: "member",
		createdAt: new Date(),
	});
	return id;
}

async function contact(org: string, email: string) {
	const id = `ct-${uid()}`;
	await db.insert(schema.contacts).values({
		id,
		organization_id: org,
		email,
		first_name: "Ana",
		created_at: iso(),
		updated_at: iso(),
	});
	return { id, email };
}

describe("contact notes and follow-ups", () => {
	it("keeps notes and follow-ups, shows conversation notes, and finishes follow-ups", async () => {
		const org = await seedOrg();
		const rosa = await member(org.id, "Rosa");
		const luis = await member(org.id, "Luis");
		const ana = await contact(org.id, "ana@example.com");
		const author = { type: "person" as const, id: rosa, name: "Rosa" };

		const note = await addContactNote({
			organizationId: org.id,
			brand: org.id,
			contactId: ana.id,
			author,
			input: { text: "Prefers WhatsApp over email" },
		});
		expect(note.kind).toBe("note");
		expect(note.assignee_id).toBeNull();

		// A follow-up without an assignee is the author's; one for someone else is theirs.
		const now = Date.now();
		const late = await addContactNote({
			organizationId: org.id,
			brand: org.id,
			contactId: ana.id,
			author,
			input: { text: "Call her back", due_at: iso(now - 3_600_000) },
			now,
		});
		expect(late).toMatchObject({ kind: "follow_up", assignee_id: rosa, overdue: true });
		const later = await addContactNote({
			organizationId: org.id,
			brand: org.id,
			contactId: ana.id,
			author,
			input: { text: "Send the quote", due_at: "2099-01-02", assignee_id: luis },
		});
		expect(later).toMatchObject({ assignee: "Luis", due_at: "2099-01-02T09:00:00.000Z" });

		// Someone outside the team can't get one.
		await expect(
			addContactNote({
				organizationId: org.id,
				brand: org.id,
				contactId: ana.id,
				author,
				input: { text: "x", due_at: "2099-01-01", assignee_id: "user_nobody" },
			}),
		).rejects.toThrow(/isn't on the team/);

		// A note left on one of her conversations shows with them.
		const conv = `cv-${uid()}`;
		await db.insert(schema.conversations).values({
			id: conv,
			organization_id: org.id,
			subject: "Room for Friday",
			contact: "Ana <ana@example.com>",
			contact_address: "ana@example.com",
			last_message_at: iso(),
			created_at: iso(),
			updated_at: iso(),
		});
		await db.insert(schema.conversationNotes).values({
			id: `cn-${uid()}`,
			organization_id: org.id,
			conversation_id: conv,
			author_type: "person",
			author_name: "Luis",
			text: "She asked for a late check-out",
			created_at: iso(),
			updated_at: iso(),
		});

		let all = await contactNotes(org.id, ana);
		expect(all.follow_ups.map((f) => f.text)).toEqual(["Call her back", "Send the quote"]);
		expect(all.notes.map((n) => n.text)).toEqual(["Prefers WhatsApp over email"]);
		expect(all.conversation_notes).toMatchObject([
			{ text: "She asked for a late check-out", subject: "Room for Friday" },
		]);

		// Rosa's follow-ups due by now: the late one only.
		const mine = await openFollowUps({ brands: [org.id], assignee: rosa, dueBy: iso(now) });
		expect(mine.map((f) => f.text)).toEqual(["Call her back"]);
		expect(mine[0]?.contact).toMatchObject({ email: "ana@example.com", name: "Ana" });

		// Today shows it to Rosa.
		const t = await today(
			{ brands: [org.id], userId: rosa, canApprove: false, canReply: true, names: new Map() },
			now,
		);
		expect(t.follow_ups.map((f) => f.text)).toEqual(["Call her back"]);

		// The inbox's person panel has the open follow-ups and the last note.
		const p = await personPanel(org.id, "ana@example.com", conv);
		expect(p.contact && "notes" in p ? p.notes : null).toMatchObject({
			count: 3,
			follow_ups: [{ text: "Call her back" }, { text: "Send the quote" }],
			last_note: { text: "Prefers WhatsApp over email" },
		});

		// Done: it moves to the notes, struck through; reopening brings it back.
		const done = await updateContactNote({
			organizationId: org.id,
			brand: org.id,
			id: late.id,
			author: { type: "person", id: luis, name: "Luis" },
			input: { done: true },
		});
		expect(done).toMatchObject({ done_by: "Luis", overdue: false });
		all = await contactNotes(org.id, ana);
		expect(all.follow_ups.map((f) => f.text)).toEqual(["Send the quote"]);
		expect((await contactNoteSummary(org.id, ana.id)).follow_ups).toHaveLength(1);

		// Taking the due date away makes it a plain note again.
		const plain = await updateContactNote({
			organizationId: org.id,
			brand: org.id,
			id: later.id,
			author,
			input: { due_at: null },
		});
		expect(plain).toMatchObject({ kind: "note", assignee_id: null });

		await deleteContactNote(org.id, note.id);
		await expect(deleteContactNote(org.id, note.id)).rejects.toThrow(/gone/);
		// Another brand can't touch them.
		const other = await seedOrg();
		await expect(deleteContactNote(other.id, later.id)).rejects.toThrow(/gone/);
		await expect(
			addContactNote({
				organizationId: other.id,
				brand: other.id,
				contactId: ana.id,
				author,
				input: { text: "hi" },
			}),
		).rejects.toThrow(/gone/);
	});
});
