/**
 * src/lib/auth-client.ts for the demo: Better Auth's browser client, answered here. Switching
 * organizations works (it's the session's); creating one adds it to the demo's database;
 * everything about signing in and security says it's done, since there's no account behind it.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { DEMO_USER, demoSession, sessionAnswer } from "../session";

const ok = <T>(data: T) => Promise.resolve({ data, error: null });

async function createOrganization({ name, slug }: { name: string; slug: string }) {
	const id = `org_${crypto.randomUUID().slice(0, 8)}`;
	const now = new Date();
	await db.insert(schema.organization).values({ id, name, slug, createdAt: now });
	await db.insert(schema.member).values({
		id: `mem_${crypto.randomUUID().slice(0, 8)}`,
		organizationId: id,
		userId: DEMO_USER.id,
		role: "owner",
		createdAt: now,
	});
	demoSession.activeOrganizationId = id;
	return ok({ id, name, slug, createdAt: now, logo: null, metadata: null, members: [] });
}

export const authClient = {
	getSession: () => ok(sessionAnswer()),
	useSession: () => ({ data: sessionAnswer(), isPending: false, error: null }),
	signOut: async () => {
		location.href = import.meta.env.BASE_URL.replace(/demo\/?$/, "");
		return { data: { success: true }, error: null };
	},
	signIn: {
		email: () => ok({}),
		emailOtp: () => ok({}),
		social: () => ok({}),
		passkey: () => ok({}),
	},
	emailOtp: { sendVerificationOtp: () => ok({ success: true }) },
	changePassword: () => ok({}),
	requestPasswordReset: () => ok({}),
	resetPassword: () => ok({}),
	updateUser: async ({ name }: { name?: string }) => {
		if (name)
			await db.update(schema.user).set({ name }).where(eq(schema.user.id, DEMO_USER.id));
		return { data: { status: true }, error: null };
	},
	listAccounts: () => ok([{ id: "acc_demo", providerId: "credential", accountId: DEMO_USER.id }]),
	linkSocial: () => ok({}),
	unlinkAccount: () => ok({}),
	passkey: {
		listUserPasskeys: () => ok([]),
		deletePasskey: () => ok({}),
		addPasskey: () => ok({}),
	},
	twoFactor: {
		enable: () =>
			ok({
				totpURI: "otpauth://totp/Mailroom:alex@example.com?secret=DEMO",
				backupCodes: [],
			}),
		disable: () => ok({}),
		generateBackupCodes: () => ok({ backupCodes: ["demo-0000", "demo-1111"] }),
		verifyTotp: () => ok({}),
		verifyBackupCode: () => ok({}),
	},
	organization: {
		setActive: async ({ organizationId }: { organizationId: string | null }) => {
			if (organizationId) {
				const m = await db
					.select({ id: schema.member.id })
					.from(schema.member)
					.where(
						and(
							eq(schema.member.organizationId, organizationId),
							eq(schema.member.userId, DEMO_USER.id),
						),
					)
					.get();
				if (!m) return { data: null, error: { message: "Not a member", status: 403 } };
			}
			demoSession.activeOrganizationId = organizationId;
			return { data: { id: organizationId }, error: null };
		},
		create: createOrganization,
		acceptInvitation: () => ok({}),
	},
	$fetch: () => ok({}),
};

export const passkeysSupported = () => false;
