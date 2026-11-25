import { describe, expect, it, vi } from "vitest";
import {
	aiSettingsView,
	clearAiSettings,
	draftReplyWithAi,
	getAiSettings,
	polishReplyWithAi,
	saveAiSettings,
	summarizeConversationWithAi,
} from "@/server/ai";
import { createAutomation, simulateAutomation } from "@/server/automations";
import { createProperty, upsertContact } from "@/server/contacts";
import {
	bulkUpdateConversations,
	getConversation,
	mergeConversations,
	startConversation,
} from "@/server/conversations";
import { sender } from "@/server/inbox-api";
import { memberActor } from "@/server/inboxes";
import { fakeOutside, seedOrg, uid } from "./helpers";

function actorFor(orgId: string, userId = `user_${uid()}`) {
	return memberActor({
		organizationId: orgId,
		brands: [orgId],
		userId,
		name: "Ana",
		canReply: true,
		masked: false,
	});
}

describe("Inbox upgrades, AI Copilot, and Automation dry-run", () => {
	it("starts a new outbound conversation, bulk-updates, and merges duplicates", async () => {
		fakeOutside();
		const org = await seedOrg();
		const actor = actorFor(org.id);

		const c1 = await startConversation(
			actor,
			{
				from: `support@${org.domain}`,
				to: "guest@cliente.test",
				subject: "Welcome aboard",
				text: "Let us know if you need anything!",
			},
			sender({ source: "dashboard" }),
		);
		const c2 = await startConversation(
			actor,
			{
				from: `support@${org.domain}`,
				to: "guest@cliente.test",
				subject: "Second thread",
				text: "Following up here too.",
			},
			sender({ source: "dashboard" }),
		);

		expect(c1.status).toBe("open");
		expect(c1.messages).toBe(1);

		const bulk = await bulkUpdateConversations(actor, [c1.id, c2.id], {
			add_tags: ["vip"],
			priority: "high",
		});
		expect(bulk.updated).toBe(2);
		expect(bulk.failed).toHaveLength(0);

		const merged = await mergeConversations(actor, c1.id, [c2.id]);
		expect(merged.id).toBe(c1.id);
		expect(merged.messages).toBe(2);
		expect(merged.tags).toContain("vip");

		const full = await getConversation(actor, c1.id);
		expect(full.timeline.filter((t) => t.type === "reply")).toHaveLength(2);
	});

	it("encrypts BYO AI keys, drafts replies, summarizes threads, and polishes text", async () => {
		fakeOutside();
		const org = await seedOrg();
		const actor = actorFor(org.id);
		const conv = await startConversation(
			actor,
			{
				from: `support@${org.domain}`,
				to: "maya@cliente.test",
				subject: "Invoice question",
				text: "Hi Maya, checking in on your invoice.",
			},
			sender({ source: "dashboard" }),
		);

		const saved = await saveAiSettings(
			org.id,
			{
				provider: "openai",
				model: "gpt-4o-mini",
				api_key: "sk-test-secret-1234",
				copilot_enabled: true,
				auto_mode: "draft",
			},
			"user_1",
		);
		expect(saved.configured).toBe(true);
		expect(saved.api_key_hint).toBe("…1234");
		expect((await getAiSettings(org.id))?.api_key_encrypted).not.toContain("sk-test-secret");

		// Mock OpenAI responses
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.openai.com")) {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										summary: "Customer asked about an invoice.",
										bullets: ["Invoice follow-up sent"],
										sentiment: "neutral",
									}),
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("{}", { status: 200 });
		});

		const drafted = await draftReplyWithAi(actor, conv.id);
		expect(drafted.text.length).toBeGreaterThan(5);

		const summarized = await summarizeConversationWithAi(actor, conv.id);
		expect(summarized.summary).toContain("invoice");
		expect(summarized.sentiment).toBe("neutral");

		const polished = await polishReplyWithAi(org.id, "hey here is ur invoice", "friendly");
		expect(polished.text.length).toBeGreaterThan(5);

		spy.mockRestore();
		const cleared = await clearAiSettings(org.id);
		expect(cleared.configured).toBe(false);
		expect(aiSettingsView(await getAiSettings(org.id)).configured).toBe(false);
	});

	it("dry-runs an automation for a contact without sending emails", async () => {
		const org = await seedOrg();
		await createProperty(org.id, { key: "plan", type: "string" });
		await upsertContact(org.id, {
			email: "pro@cliente.test",
			first_name: "Pro",
			properties: { plan: "pro" },
		});
		const auto = await createAutomation(org.id, {
			name: "Pro welcome",
			trigger: { type: "contact.created" },
			steps: [
				{
					type: "condition",
					property: "plan",
					equals: "pro",
					no: [
						{
							type: "email",
							from: `hi@${org.domain}`,
							subject: "Starter welcome",
							body: "Hi starter",
						},
					],
				},
				{ type: "wait", minutes: 60 },
				{
					type: "email",
					from: `hi@${org.domain}`,
					subject: "Pro welcome",
					body: "Hi pro",
				},
			],
		});

		const proRun = await simulateAutomation(org.id, auto.id, "pro@cliente.test");
		expect(proRun.contact.exists).toBe(true);
		expect(proRun.outcome).toBe("complete");
		expect(proRun.steps[0]?.outcome).toBe("branch_yes");
		expect(proRun.steps[1]?.outcome).toBe("would_wait");
		expect(proRun.steps[2]?.detail).toContain("Pro welcome");

		const unknownRun = await simulateAutomation(org.id, auto.id, "free@cliente.test");
		expect(unknownRun.contact.exists).toBe(false);
		expect(unknownRun.steps[0]?.outcome).toBe("branch_no");
		expect(unknownRun.steps[1]?.detail).toContain("Starter welcome");
	});
});
