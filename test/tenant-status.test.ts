import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/server/db";
import { refreshTenantStatus } from "@/server/provision";
import { iso } from "@/server/time";
import { fakeOutside, seedOrg } from "./helpers";

/** SES's tenant reputation endpoint fails with `fail`; everything else answers as usual. */
function sesReputationFails(fail: () => Response | Promise<never>) {
	fakeOutside({
		extra: (url) =>
			url.host.startsWith("email.") && url.pathname.includes("/reputation/entities/")
				? fail()
				: undefined,
	});
}

const timeout = () =>
	Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

async function checkedAt(organizationId: string, at: string | null) {
	await db
		.update(schema.orgSending)
		.set({ tenant_checked_at: at })
		.where(eq(schema.orgSending.organization_id, organizationId));
}

afterEach(() => vi.restoreAllMocks());

describe("refreshTenantStatus", () => {
	it("only warns when SES times out on a status read recently (MAILROOM-P)", async () => {
		const org = await seedOrg();
		await checkedAt(org.id, iso(Date.now() - 5 * 60_000));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		sesReputationFails(timeout);
		const row = await refreshTenantStatus(org.id);
		expect(row?.organization_id).toBe(org.id);
		expect(error).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
	});

	it("reports the timeout once the status hasn't been read for over an hour", async () => {
		const org = await seedOrg();
		await checkedAt(org.id, iso(Date.now() - 2 * 60 * 60_000));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		sesReputationFails(timeout);
		await refreshTenantStatus(org.id);
		expect(error).toHaveBeenCalledOnce();
	});

	it("still reports a refusal that isn't passing, however recent the status", async () => {
		const org = await seedOrg();
		await checkedAt(org.id, iso(Date.now() - 5 * 60_000));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		sesReputationFails(() =>
			Response.json(
				{ message: "not authorized" },
				{ status: 403, headers: { "x-amzn-ErrorType": "AccessDeniedException" } },
			),
		);
		await refreshTenantStatus(org.id);
		expect(error).toHaveBeenCalledOnce();
	});
});
