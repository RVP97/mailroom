import type { AwsConfig } from "./ses";
import { signV4 } from "./sigv4";

/**
 * AWS Cost Explorer (JSON 1.1 API), signed by hand: what the account has cost, by service, and
 * AWS's forecast for the month. Cost Explorer lives only in us-east-1, whatever region SES is
 * in, and AWS charges $0.01 for every call, so callers cache what it answers (src/server/costs.ts).
 */

const CE_REGION = "us-east-1";
const CE_URL = new URL(`https://ce.${CE_REGION}.amazonaws.com/`);

/** Cost Explorer answered with an error. */
export class CostExplorerError extends Error {
	constructor(
		readonly status: number,
		readonly type: string,
		message: string,
	) {
		super(message || type || `Cost Explorer ${status}`);
		this.name = "CostExplorerError";
	}
}

async function ceCall<T>(aws: AwsConfig, action: string, body: unknown): Promise<T> {
	const payload = JSON.stringify(body);
	const headers = await signV4({
		method: "POST",
		url: CE_URL,
		body: payload,
		region: CE_REGION,
		service: "ce",
		credentials: aws.credentials,
		contentType: "application/x-amz-json-1.1",
		headers: { "x-amz-target": `AWSInsightsIndexService.${action}` },
	});
	const res = await (aws.fetcher ?? fetch)(CE_URL, {
		method: "POST",
		headers,
		body: payload,
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	if (res.ok) return (text ? JSON.parse(text) : {}) as T;
	let type = "";
	let message = text;
	try {
		const parsed = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
		type = (parsed.__type ?? "").split("#").pop() ?? "";
		message = parsed.Message ?? parsed.message ?? text;
	} catch {}
	throw new CostExplorerError(
		res.status,
		type || (res.headers.get("x-amzn-errortype") ?? ""),
		message,
	);
}

interface Amount {
	Amount?: string;
	Unit?: string;
}

interface CostAndUsage {
	ResultsByTime?: {
		TimePeriod?: { Start?: string; End?: string };
		Total?: Record<string, Amount>;
		Groups?: { Keys?: string[]; Metrics?: Record<string, Amount> }[];
		Estimated?: boolean;
	}[];
	NextPageToken?: string;
}

/** One month's cost line: a service and a record type (Usage, Tax, Credit, Refund…). */
export interface CostLine {
	service: string;
	recordType: string;
	amount: number;
}

export interface MonthCost {
	/** The month's first day, YYYY-MM-DD. */
	start: string;
	/** AWS's figures for the month aren't final yet. */
	estimated: boolean;
	unit: string;
	lines: CostLine[];
}

/**
 * The unblended cost of each month from `start` up to (not including) `end`, by service and
 * record type: a single call (two pages at most for a small account).
 */
export async function monthlyCosts(
	aws: AwsConfig,
	start: string,
	end: string,
): Promise<MonthCost[]> {
	const months = new Map<string, MonthCost>();
	let token: string | undefined;
	do {
		const res = await ceCall<CostAndUsage>(aws, "GetCostAndUsage", {
			TimePeriod: { Start: start, End: end },
			Granularity: "MONTHLY",
			Metrics: ["UnblendedCost"],
			GroupBy: [
				{ Type: "DIMENSION", Key: "SERVICE" },
				{ Type: "DIMENSION", Key: "RECORD_TYPE" },
			],
			...(token ? { NextPageToken: token } : {}),
		});
		for (const r of res.ResultsByTime ?? []) {
			const monthStart = r.TimePeriod?.Start ?? start;
			const month = months.get(monthStart) ?? {
				start: monthStart,
				estimated: !!r.Estimated,
				unit: "USD",
				lines: [],
			};
			month.estimated ||= !!r.Estimated;
			for (const g of r.Groups ?? []) {
				const m = g.Metrics?.UnblendedCost;
				const amount = Number(m?.Amount ?? 0);
				if (!Number.isFinite(amount) || amount === 0) continue;
				if (m?.Unit) month.unit = m.Unit;
				month.lines.push({
					service: g.Keys?.[0] ?? "Other",
					recordType: g.Keys?.[1] ?? "Usage",
					amount,
				});
			}
			months.set(monthStart, month);
		}
		token = res.NextPageToken;
	} while (token);
	return [...months.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * AWS's forecast of the unblended cost from `start` (today at the earliest) up to `end`; null
 * when it has too little history to forecast (a new account).
 */
export async function costForecast(
	aws: AwsConfig,
	start: string,
	end: string,
): Promise<{ amount: number; unit: string } | null> {
	try {
		const res = await ceCall<{ Total?: Amount }>(aws, "GetCostForecast", {
			TimePeriod: { Start: start, End: end },
			Metric: "UNBLENDED_COST",
			Granularity: "MONTHLY",
		});
		const amount = Number(res.Total?.Amount);
		return Number.isFinite(amount) ? { amount, unit: res.Total?.Unit ?? "USD" } : null;
	} catch (error) {
		if (error instanceof CostExplorerError && error.type === "DataUnavailableException")
			return null;
		throw error;
	}
}
