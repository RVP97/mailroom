import { describe, expect, it } from "vitest";
import { mockAwsFetch } from "../src/server/aws/mock";
import { getAccount, sendRaw } from "../src/server/aws/ses";
import { callerAccount, createTopic } from "../src/server/aws/sns";
import { isLocalBaseUrl } from "../src/server/env";

const setup = () => {
	const applied: { type: string; to: string; bounceType?: string }[] = [];
	const fetcher = mockAwsFetch(
		async (e) => {
			const ev = e as {
				eventType: string;
				mail: { destination: string[] };
				bounce?: { bounceType?: string };
			};
			applied.push({
				type: ev.eventType,
				to: ev.mail.destination[0] ?? "",
				bounceType: ev.bounce?.bounceType,
			});
		},
		0,
		() => {},
	);
	const aws = {
		region: "us-east-1",
		credentials: { accessKeyId: "x", secretAccessKey: "y" },
		fetcher,
	};
	return { aws, applied };
};
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("AWS_MOCK", () => {
	it("answers the account as out of the sandbox, and the query APIs", async () => {
		const { aws } = setup();
		expect((await getAccount(aws)).ProductionAccessEnabled).toBe(true);
		expect(await callerAccount(aws)).toBe("000000000000");
		expect(await createTopic(aws, "mailroom")).toContain(":mailroom");
	});

	it("turns the simulator's local parts into SES events", async () => {
		const cases: [string, string[], string | undefined][] = [
			["someone@example.com", ["Delivery"], undefined],
			["bounce@example.com", ["Bounce"], "Permanent"],
			["ooto@example.com", ["Bounce"], "Transient"],
			["complaint@example.com", ["Delivery", "Complaint"], undefined],
		];
		for (const [to, want, bounceType] of cases) {
			const { aws, applied } = setup();
			const id = await sendRaw(aws, { raw: "eA==", from: "a@b.co", to: [to] });
			expect(id).toMatch(/^0100-mock-/);
			await settle();
			expect(applied.map((a) => a.type)).toEqual(want);
			if (bounceType) expect(applied[0]?.bounceType).toBe(bounceType);
		}
	});

	it("only permits AWS_MOCK on local URLs", () => {
		expect(isLocalBaseUrl("")).toBe(true);
		expect(isLocalBaseUrl("http://localhost:3000")).toBe(true);
		expect(isLocalBaseUrl("http://127.0.0.1:8787")).toBe(true);
		expect(isLocalBaseUrl("https://mailroom.localhost")).toBe(true);
		expect(isLocalBaseUrl("https://mailroom.example.com")).toBe(false);
		expect(isLocalBaseUrl("https://localhost.example.com")).toBe(false);
	});
});
