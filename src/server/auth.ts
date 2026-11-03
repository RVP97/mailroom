import { env, waitUntil } from "cloudflare:workers";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { emailOTP, organization, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq, gt } from "drizzle-orm";
import { ac, roles } from "../lib/roles";
import { db, schema } from "./db";
import { baseUrl, cfg, isAdminEmail } from "./env";
import { hashPassword, verifyPassword } from "./password";
import { sendSystemEmail, systemLayout } from "./system-email";

/**
 * Sign-in with a passkey, a six-digit code by email, a password (set in Account; hashed with
 * the runtime's PBKDF2, src/server/password.ts), or Google (when GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set, the same OAuth client as Gmail Postmaster Tools, with the
 * redirect URI <BETTER_AUTH_URL>/api/auth/callback/google). Two-factor authentication (an
 * authenticator app, with backup codes) asks for a code after a password or an emailed code;
 * a passkey is already two factors, and Google has its own. Nobody signs up on their own: the
 * ADMIN_EMAILS, and whoever an organization invited. Organizations are Better Auth's (owner,
 * admin, member).
 */

const background = (p: Promise<unknown>) => {
	const caught = p.catch((error) => console.error("auth: email not sent", error));
	try {
		waitUntil(caught);
	} catch {
		return caught;
	}
};

async function invited(email: string) {
	const row = await db
		.select({ id: schema.invitation.id })
		.from(schema.invitation)
		.where(
			and(
				eq(schema.invitation.email, email.toLowerCase()),
				eq(schema.invitation.status, "pending"),
				gt(schema.invitation.expiresAt, new Date()),
			),
		)
		.get();
	return !!row;
}

/** Whether this address can sign in: an admin, someone already in, or someone invited. */
async function mayHaveAccount(email: string) {
	if (isAdminEmail(email)) return true;
	const user = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, email.toLowerCase()))
		.get();
	return !!user || (await invited(email));
}

/**
 * Better Auth's two-factor plugin, which asks for the second code after a password sign-in,
 * also asks after an emailed code: otherwise anyone with the inbox could skip it. Without a
 * password (signed in by code, passkey or Google), 2FA is managed with the session alone.
 */
function twoFactorEverywhere() {
	const plugin = twoFactor({
		issuer: "Mailroom",
		allowPasswordless: true,
		backupCodeOptions: { amount: 10, length: 10 },
	});
	return {
		...plugin,
		hooks: {
			after: plugin.hooks.after.map((h) => ({
				...h,
				matcher: (ctx: Parameters<typeof h.matcher>[0]) =>
					h.matcher(ctx) || ctx.path === "/sign-in/email-otp",
			})),
		},
	} as typeof plugin;
}

function createAuth() {
	const url = baseUrl() || "http://localhost:3000";
	const host = new URL(url).hostname;
	return betterAuth({
		appName: "Mailroom",
		baseURL: url,
		secret: (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, { provider: "sqlite", schema }),
		session: {
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			// A signed cookie answers most session checks without the database.
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		// Passwords are optional, set in Account (never at sign-up: there's none).
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 10,
			maxPasswordLength: 128,
			password: { hash: hashPassword, verify: verifyPassword },
			revokeSessionsOnPasswordReset: true,
			resetPasswordTokenExpiresIn: 60 * 60,
			async sendResetPassword({ user, url: link }) {
				const { html, text } = systemLayout({
					title: "Reset your password",
					lines: [
						"Choose a new password for Mailroom. The link works for an hour.",
						"If you didn't ask for it, ignore this email: your password stays the same.",
					],
					button: { label: "Choose a new password", url: link },
				});
				await background(
					sendSystemEmail({
						to: user.email,
						subject: "Reset your Mailroom password",
						html,
						text,
					}),
				);
			},
		},
		...(googleSignIn()
			? {
					socialProviders: {
						google: {
							clientId: cfg().GOOGLE_CLIENT_ID as string,
							clientSecret: cfg().GOOGLE_CLIENT_SECRET as string,
							prompt: "select_account" as const,
						},
					},
					// The same person's existing account (made by an emailed code or invitation) gets
					// Google as another way in, when Google says it verified the address (not trusted
					// blindly: a Google account can carry an address its owner never proved). Unlinking
					// it is always fine: an emailed code still signs them in.
					account: {
						accountLinking: {
							enabled: true,
							allowUnlinkingAll: true,
						},
					},
				}
			: {}),
		advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
		rateLimit: { enabled: true, window: 60, max: 30 },
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						if (isAdminEmail(user.email) || (await invited(user.email)))
							return { data: user };
						throw new APIError("FORBIDDEN", {
							message:
								"This address has no invitation. Ask an admin of your organization to invite you.",
						});
					},
				},
			},
		},
		plugins: [
			emailOTP({
				otpLength: 6,
				expiresIn: 10 * 60,
				allowedAttempts: 5,
				storeOTP: "hashed",
				async sendVerificationOTP({ email, otp }) {
					// No code for an address that couldn't sign in anyway (and no email for SES to
					// send to strangers typing addresses in).
					if (!(await mayHaveAccount(email))) return;
					const { html, text } = systemLayout({
						title: "Your sign-in code",
						lines: [
							"Enter this code to sign in to Mailroom. It works for 10 minutes.",
							"If you didn't ask for it, ignore this email.",
						],
						code: otp,
					});
					await background(
						sendSystemEmail({
							to: email,
							subject: `${otp} is your Mailroom code`,
							html,
							text,
						}),
					);
				},
			}),
			passkey({ rpID: host, rpName: "Mailroom", origin: url }),
			twoFactorEverywhere(),
			organization({
				creatorRole: "owner",
				// Better Auth's roles plus Support (src/lib/roles.ts).
				ac,
				roles,
				// Admins create organizations; members join by invitation.
				allowUserToCreateOrganization: (user) => isAdminEmail(user.email),
				invitationExpiresIn: 7 * 86_400,
				async sendInvitationEmail(data) {
					const { html, text } = systemLayout({
						title: `Join ${data.organization.name} on Mailroom`,
						lines: [
							`${data.inviter.user.name || data.inviter.user.email} invited you to ${data.organization.name}.`,
							"Sign in with this email address to accept.",
						],
						button: {
							label: "Accept invitation",
							url: `${url}/login?invitation=${data.id}`,
						},
					});
					await background(
						sendSystemEmail({
							to: data.email,
							subject: `Join ${data.organization.name} on Mailroom`,
							html,
							text,
						}),
					);
				},
			}),
			tanstackStartCookies(),
		],
	});
}

/** Google sign-in is offered when the deployment has a Google OAuth client. */
export const googleSignIn = () => !!cfg().GOOGLE_CLIENT_ID && !!cfg().GOOGLE_CLIENT_SECRET;

let instance: ReturnType<typeof createAuth> | null = null;
export const auth = () => {
	instance ??= createAuth();
	return instance;
};
export type Auth = ReturnType<typeof createAuth>;

export const isAdmin = isAdminEmail;
