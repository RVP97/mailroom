import { beforeEach, describe, expect, it, vi } from "vitest";
import { awsCosts, summarize } from "@/server/costs";
import { db, schema } from "@/server/db";
import { clearSettingsCache } from "@/server/settings";

/** Cost Explorer, faked: answers by X-Amz-Target and records each call. */
function fakeCostExplorer(o: { denied?: boolean; noForecast?: boolean } = {}) {
	const calls: { target: string; body: Record<string, unknown>; headers: Headers }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		if (url.host !== "ce.us-east-1.amazonaws.com") throw new Error(`Unexpected ${url}`);
		const target = request.headers.get("x-amz-target") ?? "";
		const body = (await request.json()) as Record<string, unknown>;
		calls.push({ target, body, headers: request.headers });
		if (o.denied)
			return Response.json(
				{
					__type: "com.amazon.coral.service#AccessDeniedException",
					Message: "User is not authorized to perform: ce:GetCostAndUsage",
				},
				{ status: 400 },
			);
		if (target.endsWith("GetCostForecast"))
			return o.noForecast
				? Response.json(
						{ __type: "DataUnavailableException", Message: "Insufficient data" },
						{ status: 400 },
					)
				: Response.json({ Total: { Amount: "1.5", Unit: "USD" } });
		const group = (service: string, recordType: string, amount: string) => ({
			Keys: [service, recordType],
			Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } },
		});
		return Response.json({
			ResultsByTime: [
				{
					TimePeriod: { Start: "2026-10-01", End: "2026-11-01" },
					Estimated: false,
					Groups: [
						group("Amazon Simple Email Service", "Usage", "3.2"),
						group("Amazon Simple Email Service", "Credit", "-3.2"),
					],
				},
				{
					TimePeriod: { Start: "2026-11-01", End: "2026-11-15" },
					Estimated: true,
					Groups: [
						group("Amazon Simple Email Service", "Usage", "0.9"),
						group("Amazon Simple Storage Service", "Usage", "0.0004"),
						group("Tax", "Tax", "0.15"),
						group("AWS Cost Explorer", "Usage", "0"),
					],
				},
			],
		});
	});
	return calls;
}

const NOW = new Date("2026-11-14T18:00:00Z");

describe("AWS costs", () => {
	beforeEach(async () => {
		await db.delete(schema.appSettings);
		clearSettingsCache();
	});

	it("asks for last month and this one by service in one signed call, plus the forecast", async () => {
		const calls = fakeCostExplorer();
		const costs = await awsCosts({ now: NOW });
		expect(calls.map((c) => c.target).sort()).toEqual([
			"AWSInsightsIndexService.GetCostAndUsage",
			"AWSInsightsIndexService.GetCostForecast",
		]);
		const usage = calls.find((c) => c.target.endsWith("GetCostAndUsage"));
		expect(usage?.body.TimePeriod).toEqual({ Start: "2026-10-01", End: "2026-11-15" });
		expect(usage?.headers.get("authorization")).toMatch(
			/Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ce\/aws4_request, SignedHeaders=[^,]*x-amz-target/,
		);
		const forecast = calls.find((c) => c.target.endsWith("GetCostForecast"));
		expect(forecast?.body.TimePeriod).toEqual({ Start: "2026-11-14", End: "2026-12-01" });

		expect(costs?.error).toBeNull();
		expect(costs?.thisMonth).toMatchObject({
			start: "2026-11-01",
			total: 1.05,
			credits: 0,
			estimated: true,
		});
		expect(costs?.thisMonth?.byService.map((s) => s.service)).toEqual([
			"Amazon Simple Email Service",
			"Tax",
			"Amazon Simple Storage Service",
		]);
		expect(costs?.lastMonth).toMatchObject({ total: 0, charges: 3.2, credits: -3.2 });
		expect(costs?.forecast).toBe(2.55);
	});

	it("keeps the answer: no new paid calls until it's a day old or the month changes", async () => {
		const calls = fakeCostExplorer();
		await awsCosts({ now: NOW });
		await awsCosts({ now: new Date(NOW.getTime() + 20 * 3600_000) });
		// Update asks again, but not twice within a few minutes.
		await awsCosts({ now: new Date(NOW.getTime() + 5 * 60_000), force: true });
		expect(calls).toHaveLength(2);
		await awsCosts({ now: new Date(NOW.getTime() + 2 * 3600_000), force: true });
		expect(calls).toHaveLength(4);
		await awsCosts({ now: new Date(NOW.getTime() + 27 * 3600_000) });
		expect(calls).toHaveLength(6);
	});

	it("says which permissions are missing, and keeps the last good numbers", async () => {
		fakeCostExplorer();
		await awsCosts({ now: NOW });
		fakeCostExplorer({ denied: true });
		const costs = await awsCosts({ now: new Date(NOW.getTime() + 25 * 3600_000) });
		expect(costs?.error).toMatch(/ce:GetCostAndUsage and ce:GetCostForecast/);
		expect(costs?.thisMonth?.total).toBe(1.05);
	});

	it("shows no forecast for an account too new to have one", async () => {
		fakeCostExplorer({ noForecast: true });
		const costs = await awsCosts({ now: NOW });
		expect(costs?.error).toBeNull();
		expect(costs?.forecast).toBeNull();
	});

	it("nets credits against charges", () => {
		expect(
			summarize({
				start: "2026-11-01",
				estimated: true,
				unit: "USD",
				lines: [
					{ service: "SES", recordType: "Usage", amount: 5 },
					{ service: "SES", recordType: "Credit", amount: -4 },
				],
			}),
		).toMatchObject({ total: 1, charges: 5, credits: -4 });
	});
});
