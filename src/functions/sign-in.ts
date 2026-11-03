import { createServerFn } from "@tanstack/react-start";
import { googleSignIn } from "@/server/auth";

/** The ways the sign-in page offers besides an emailed code and passkeys. */
export const signInOptionsFn = createServerFn({ method: "GET" }).handler(() => ({
	google: googleSignIn(),
}));
