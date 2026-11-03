import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { sessionMiddleware } from "@/server/middleware";
import { verifyPassword } from "@/server/password";

/** Account › Password and Two-factor authentication: what's set, and the server-only steps. */

const credential = (userId: string) =>
	and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential"));

const refuse = (message: string, status = 400) => new Response(message, { status });

/** Better Auth's refusals as the message the dashboard shows. */
async function viaAuth<T>(fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof APIError) throw refuse(error.message || "That didn't work");
		throw error;
	}
}

export const securityFn = createServerFn({ method: "GET" })
	.middleware([sessionMiddleware])
	.handler(async ({ context }) => {
		const [account, user] = await Promise.all([
			db
				.select({ password: schema.account.password, updatedAt: schema.account.updatedAt })
				.from(schema.account)
				.where(credential(context.userId))
				.get(),
			db
				.select({ twoFactorEnabled: schema.user.twoFactorEnabled })
				.from(schema.user)
				.where(eq(schema.user.id, context.userId))
				.get(),
		]);
		return {
			hasPassword: !!account?.password,
			passwordChangedAt: account?.password ? account.updatedAt.toISOString() : null,
			twoFactor: !!user?.twoFactorEnabled,
		};
	});

/** A first password, for someone who signs in with codes, passkeys or Google. */
export const setPasswordFn = createServerFn({ method: "POST" })
	.middleware([sessionMiddleware])
	.validator(z.object({ password: z.string().min(1).max(128) }))
	.handler(async ({ data, context }) => {
		const existing = await db
			.select({ password: schema.account.password })
			.from(schema.account)
			.where(credential(context.userId))
			.get();
		if (existing?.password) throw refuse("You already have a password. Change it instead.");
		await viaAuth(() =>
			auth().api.setPassword({
				body: { newPassword: data.password },
				headers: getRequest().headers,
			}),
		);
		return { ok: true };
	});

/** Back to signing in without one; asks for the current password first. */
export const removePasswordFn = createServerFn({ method: "POST" })
	.middleware([sessionMiddleware])
	.validator(z.object({ password: z.string().min(1).max(128) }))
	.handler(async ({ data, context }) => {
		const account = await db
			.select({ id: schema.account.id, password: schema.account.password })
			.from(schema.account)
			.where(credential(context.userId))
			.get();
		if (!account?.password) throw refuse("You don't have a password.");
		if (!(await verifyPassword({ hash: account.password, password: data.password })))
			throw refuse("That password isn't right.");
		await db.delete(schema.account).where(eq(schema.account.id, account.id));
		return { ok: true };
	});
