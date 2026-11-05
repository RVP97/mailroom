/** The demo's one visitor: signed in as the deployment's admin, owner of every organization. */

export const DEMO_USER = {
	id: "user_demo",
	name: "Alex Rivera",
	email: "alex@example.com",
};

const KEY = "mailroom-demo:active-org";

export const demoSession = {
	get activeOrganizationId(): string | null {
		try {
			return sessionStorage.getItem(KEY);
		} catch {
			return null;
		}
	},
	set activeOrganizationId(id: string | null) {
		try {
			if (id) sessionStorage.setItem(KEY, id);
			else sessionStorage.removeItem(KEY);
		} catch {}
	},
};

export function sessionAnswer() {
	const now = new Date();
	return {
		user: {
			...DEMO_USER,
			emailVerified: true,
			image: null,
			twoFactorEnabled: false,
			createdAt: now,
			updatedAt: now,
		},
		session: {
			id: "session_demo",
			userId: DEMO_USER.id,
			token: "demo",
			expiresAt: new Date(now.getTime() + 86_400_000),
			createdAt: now,
			updatedAt: now,
			activeOrganizationId: demoSession.activeOrganizationId,
			ipAddress: null,
			userAgent: null,
		},
	};
}
