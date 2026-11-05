/** src/server/auth.ts for the demo: the session is always the demo's visitor (demo/session.ts). */
import { isAdminEmail } from "@/server/env";
import { sessionAnswer } from "../session";

export const googleSignIn = () => true;

const api = {
	getSession: async () => sessionAnswer(),
	setPassword: async () => ({ status: true }),
};

export const auth = () => ({ api, handler: async () => new Response(null, { status: 404 }) });
export type Auth = ReturnType<typeof auth>;
export const isAdmin = isAdminEmail;
