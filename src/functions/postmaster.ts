import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminMiddleware } from "@/server/middleware";
import { connection, connectUrl, disconnect, syncPostmaster } from "@/server/postmaster";

/** Gmail Postmaster Tools on the AWS account page: whether a Google account is connected. */
export const postmasterStatusFn = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.handler(() => connection());

/** Google's consent page to connect (the browser goes there). */
export const postmasterConnectFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(async () => ({ url: await connectUrl() }));

export const postmasterDisconnectFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(async () => {
		await disconnect();
		return connection();
	});

/** Registers, verifies and reads every domain now instead of waiting for the next run. */
export const postmasterSyncFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(async () => {
		await syncPostmaster();
		return connection();
	});
