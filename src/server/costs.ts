import { CostExplorerError, costForecast, type MonthCost, monthlyCosts } from "./aws/cost-explorer";
import type { AwsConfig } from "./aws/ses";
import { aws, awsConfigured } from "./env";
import { getSetting, setSetting } from "./settings";
import { iso } from "./time";

/**
 * What the AWS account costs, for the admins' AWS page: this month so far by service, last
 * month's bill and AWS's forecast for the month. Cost Explorer charges $0.01 a call and updates
 * a few times a day, so the answer is kept in app_settings and asked again only when it's
 * REFRESH_MS old (or a new month began), or when an admin asks for it (not more than once
 * every MANUAL_MS). Two calls a refresh: $0.02 a day at most (about $0.60 a month), $0 when nobody looks.
 */

const REFRESH_MS = 24 * 3600_000;
const MANUAL_MS = 3600_000;
/** A failure (say, the IAM user can't call Cost Explorer yet) is asked again sooner. */
const FAILED_MS = 3600_000;

export interface ServiceCost {
	service: string;
	amount: number;
}

export interface MonthSummary {
	/** The month's first day, YYYY-MM-DD (UTC, as AWS bills). */
	start: string;
	/** What it comes to: charges less credits. What the card is charged. */
	total: number;
	/** Usage, tax and fees. */
	charges: number;
	/** Credits, refunds and discounts, as a negative amount (0 without any). */
	credits: number;
	/** AWS's figures aren't final yet. */
	estimated: boolean;
	/** Each service's charges, most first. */
	byService: ServiceCost[];
}

export interface AwsCosts {
	fetchedAt: string;
	unit: string;
	thisMonth: MonthSummary | null;
	lastMonth: MonthSummary | null;
	/** AWS's forecast of this month's total (what's spent plus what's to come); null when it
	 * can't forecast yet. */
	forecast: number | null;
	error: string | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));
const round = (n: number) => Math.round(n * 100) / 100;

export function summarize(month: MonthCost): MonthSummary {
	const services = new Map<string, number>();
	let charges = 0;
	let credits = 0;
	for (const line of month.lines) {
		if (line.amount < 0) {
			credits += line.amount;
			continue;
		}
		charges += line.amount;
		services.set(line.service, (services.get(line.service) ?? 0) + line.amount);
	}
	return {
		start: month.start,
		total: round(charges + credits),
		charges: round(charges),
		credits: round(credits),
		estimated: month.estimated,
		byService: [...services]
			.map(([service, amount]) => ({ service, amount }))
			.sort((a, b) => b.amount - a.amount),
	};
}

/** Asks Cost Explorer: two paid calls. */
export async function fetchAwsCosts(now = new Date(), a: AwsConfig = aws()): Promise<AwsCosts> {
	const y = now.getUTCFullYear();
	const m = now.getUTCMonth();
	const thisStart = day(utc(y, m));
	const lastStart = day(utc(y, m - 1));
	const today = day(now);
	const tomorrow = day(utc(y, m, now.getUTCDate() + 1));
	const nextMonth = day(utc(y, m + 1));
	const fetchedAt = iso(now.getTime());
	try {
		const [months, forecast] = await Promise.all([
			monthlyCosts(a, lastStart, tomorrow),
			costForecast(a, today, nextMonth).catch(() => null),
		]);
		const find = (start: string) => {
			const month = months.find((x) => x.start === start);
			return month ? summarize(month) : null;
		};
		const thisMonth =
			find(thisStart) ??
			summarize({ start: thisStart, estimated: true, unit: "USD", lines: [] });
		return {
			fetchedAt,
			unit: months.find((x) => x.lines.length)?.unit ?? forecast?.unit ?? "USD",
			thisMonth,
			lastMonth: find(lastStart),
			// The forecast covers today to the month's end; what's already spent comes first.
			forecast: forecast ? round(thisMonth.total + forecast.amount) : null,
			error: null,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const denied =
			error instanceof CostExplorerError &&
			(error.type === "AccessDeniedException" || error.status === 403);
		return {
			fetchedAt,
			unit: "USD",
			thisMonth: null,
			lastMonth: null,
			forecast: null,
			error: denied
				? "The IAM user can't read Cost Explorer yet: add ce:GetCostAndUsage and ce:GetCostForecast to its policy (below)."
				: message,
		};
	}
}

const isFresh = (c: AwsCosts, now: Date) => {
	const age = now.getTime() - Date.parse(c.fetchedAt);
	const sameMonth = c.fetchedAt.slice(0, 7) === iso(now.getTime()).slice(0, 7);
	return sameMonth && age < (c.error ? FAILED_MS : REFRESH_MS);
};

async function kept(): Promise<AwsCosts | null> {
	const raw = await getSetting("aws_costs");
	if (!raw) return null;
	try {
		return JSON.parse(raw) as AwsCosts;
	} catch {
		return null;
	}
}

/**
 * The account's costs: what's kept while it's fresh, else Cost Explorer's answer (kept for
 * next time). `force` asks again unless the last answer is under MANUAL_MS old and worked.
 * Null without AWS credentials.
 */
export async function awsCosts(o: { force?: boolean; now?: Date } = {}): Promise<AwsCosts | null> {
	if (!awsConfigured()) return null;
	return costsKept({
		aws: aws(),
		cached: await kept(),
		save: (costs) => setSetting("aws_costs", JSON.stringify(costs)),
		...o,
	});
}

/**
 * Any account's costs with the same rules (the deployment's, or an organization's own,
 * org-aws-manage.ts): `cached` while it's fresh, else asked again and saved.
 */
export async function costsKept(o: {
	aws: AwsConfig;
	cached: AwsCosts | null;
	save: (costs: AwsCosts) => Promise<unknown>;
	force?: boolean;
	now?: Date;
}): Promise<AwsCosts> {
	const now = o.now ?? new Date();
	const cached = o.cached;
	if (cached) {
		const age = now.getTime() - Date.parse(cached.fetchedAt);
		const fresh = o.force ? !cached.error && age < MANUAL_MS : isFresh(cached, now);
		if (fresh) return cached;
	}
	const fetched = await fetchAwsCosts(now, o.aws);
	// A failure doesn't wipe the last good numbers: they stay, shown with the error.
	const costs =
		fetched.error && cached?.thisMonth
			? { ...cached, error: fetched.error, fetchedAt: fetched.fetchedAt }
			: fetched;
	await o.save(costs);
	return costs;
}
