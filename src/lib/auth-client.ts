import { passkeyClient } from "@better-auth/passkey/client";
import { emailOTPClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "./roles";

export const authClient = createAuthClient({
	plugins: [
		emailOTPClient(),
		passkeyClient(),
		// The sign-in page reads twoFactorRedirect from the answer and asks for the code itself.
		twoFactorClient(),
		organizationClient({ ac, roles }),
	],
});

export const passkeysSupported = () =>
	typeof window !== "undefined" && !!window.PublicKeyCredential && window.isSecureContext;
