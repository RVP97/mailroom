import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { costByOrganization } from "@/server/cost-split";
import { awsCosts } from "@/server/costs";
import { ApiError } from "@/server/errors";
import { receivingStatus } from "@/server/inbound";
import { adminMiddleware } from "@/server/middleware";
import { accountStatus, setUpAccount } from "@/server/provision";
import { dailyStats, statsByOrganization } from "@/server/queries";

/** The deployment's admins: AWS setup and the whole account's numbers. */

export const accountStatusFn = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.handler(async () => {
		const [status, byOrg, all, costs, receiving] = await Promise.all([
			accountStatus(),
			statsByOrganization(7),
			dailyStats(null, 30),
			awsCosts(),
			receivingStatus(),
		]);
		const split = await costByOrganization(costs).catch((error) => {
			console.error("admin: cost split failed", error);
			return null;
		});
		return { status, byOrg, all, costs, receiving, split };
	});

/** Asks Cost Explorer again now (unless it answered in the last few minutes). */
export const refreshCostsFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(() => awsCosts({ force: true }));

export const setUpAccountFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(async () => {
		try {
			return await setUpAccount();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Response(message, { status: error instanceof ApiError ? error.status : 502 });
		}
	});

/** Admin › Error tracking: an error on purpose, to see it arrive in Sentry. */
export const sentryTestFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(() => {
		throw new Error(`Sentry test from the Worker (${new Date().toISOString()})`);
	});
