import {
	type AuthenticationResponseJSON,
	browserSupportsWebAuthn,
	browserSupportsWebAuthnAutofill,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	startAuthentication,
	startRegistration,
	WebAuthnError,
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Adding a passkey, done so that it works in every browser.
 *
 * Better Auth's addPasskey() asks the server for options and only then calls WebAuthn. Safari
 * (and Firefox) only let a page create a passkey right after a click, and that wait for the
 * server can use the click up: the browser then answers NotAllowedError, which used to be taken
 * for "you canceled" and dropped without a word. So the options are fetched when the page opens
 * (and again before their 5-minute challenge runs out), and the click goes straight to WebAuthn.
 */

const FRESH_FOR = 4 * 60_000;

type Options = { json: PublicKeyCredentialCreationOptionsJSON; at: number };

export type PasskeyProblem = "unsupported" | "not-fresh" | null;

const messageOf = (e: unknown) =>
	e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "";

/** A name for the passkey from this browser and device: "Safari on Mac", "Chrome on Windows"… */
export function deviceLabel() {
	if (typeof navigator === "undefined") return "Passkey";
	const ua = navigator.userAgent;
	const device = /iPhone/.test(ua)
		? "iPhone"
		: /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
			? "iPad"
			: /Android/.test(ua)
				? "Android"
				: /Mac OS X|Macintosh/.test(ua)
					? "Mac"
					: /Windows/.test(ua)
						? "Windows"
						: /CrOS/.test(ua)
							? "ChromeOS"
							: /Linux/.test(ua)
								? "Linux"
								: "this device";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Firefox\//.test(ua)
			? "Firefox"
			: /Chrome\//.test(ua) || /CriOS/.test(ua)
				? "Chrome"
				: /Safari\//.test(ua)
					? "Safari"
					: null;
	return browser ? `${browser} on ${device}` : device;
}

/** Password managers by the AAGUID their passkeys carry, to say where a passkey lives. */
export const PROVIDERS: Record<string, string> = {
	"fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
	"dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
	"ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
	"adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
	"bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
	"d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
	"531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
	"08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
	"9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
	"6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
};

export function usePasskeyRegistration(userName: string) {
	const options = useRef<Options | null>(null);
	const [problem, setProblem] = useState<PasskeyProblem>(null);
	const [supported, setSupported] = useState<boolean | null>(null);
	const [adding, setAdding] = useState(false);
	// While the browser's prompt is open, a new challenge would replace the one being answered.
	const busy = useRef(false);

	const prefetch = useCallback(async () => {
		const r = await authClient.$fetch<PublicKeyCredentialCreationOptionsJSON>(
			"/passkey/generate-register-options",
			{ method: "GET", query: { name: userName }, throw: false },
		);
		if (r.data) {
			options.current = { json: r.data, at: Date.now() };
			setProblem(null);
			return options.current;
		}
		options.current = null;
		const code = (r.error as { code?: string } | null)?.code;
		if (code === "SESSION_NOT_FRESH" || r.error?.status === 403) setProblem("not-fresh");
		return null;
	}, [userName]);

	useEffect(() => {
		const ok = browserSupportsWebAuthn() && window.isSecureContext;
		setSupported(ok);
		if (!ok) return setProblem("unsupported");
		void prefetch();
		const timer = setInterval(() => !busy.current && void prefetch(), FRESH_FOR);
		const onFocus = () => {
			if (busy.current) return;
			if (!options.current || Date.now() - options.current.at > FRESH_FOR) void prefetch();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", onFocus);
		};
	}, [prefetch]);

	/** Adds a passkey. Resolves to an error message to show, or null when it worked or was canceled. */
	const add = useCallback(async (): Promise<{ ok: boolean; error: string | null }> => {
		setAdding(true);
		busy.current = true;
		try {
			let o = options.current;
			if (!o || Date.now() - o.at > FRESH_FOR) o = await prefetch();
			if (!o)
				return {
					ok: false,
					error: "Mailroom couldn't start adding a passkey. Reload the page and try again.",
				};
			// Each set of options holds a one-time challenge.
			options.current = null;
			let response: Awaited<ReturnType<typeof startRegistration>>;
			try {
				response = await startRegistration({ optionsJSON: o.json });
			} catch (e) {
				if (e instanceof WebAuthnError) {
					if (e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")
						return {
							ok: false,
							error: "This device already has a passkey for your account.",
						};
					if (e.code === "ERROR_CEREMONY_ABORTED") return { ok: false, error: null };
				}
				const name =
					e instanceof Error ? ((e as { cause?: Error }).cause?.name ?? e.name) : "";
				// NotAllowedError is what the browser says both when you close its prompt and when it
				// refuses to show one; it's only quiet when you clearly closed it.
				if (name === "NotAllowedError" || name === "AbortError")
					return {
						ok: false,
						error: /cancel/i.test(messageOf(e))
							? null
							: "No passkey was added. If your browser didn't show its prompt, try again.",
					};
				if (name === "SecurityError")
					return {
						ok: false,
						error: "Passkeys only work on Mailroom's own address (https).",
					};
				return { ok: false, error: messageOf(e) || "The passkey wasn't created." };
			}
			const { clientExtensionResults: _x, ...body } = response;
			const verified = (await authClient.$fetch("/passkey/verify-registration", {
				method: "POST",
				body: { response: body, name: deviceLabel() },
				throw: false,
			})) as { error: { message?: string } | null };
			if (verified.error)
				return {
					ok: false,
					error: verified.error.message || "Mailroom couldn't save the passkey.",
				};
			return { ok: true, error: null };
		} finally {
			setAdding(false);
			busy.current = false;
			// The next passkey needs a new challenge (only after verifying: it replaces the cookie).
			void prefetch();
		}
	}, [prefetch]);

	return { supported, problem, adding, add, refresh: prefetch };
}

/**
 * Signing in with a passkey: the button, and the browser's own autofill (your passkeys offered
 * in the email field). Both answer the same challenge, fetched when the page opens, so a click
 * goes straight to the browser's prompt.
 */
export function usePasskeySignIn(onSignedIn: () => Promise<void>) {
	const [supported, setSupported] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const options = useRef<{ json: PublicKeyCredentialRequestOptionsJSON; at: number } | null>(
		null,
	);
	const done = useRef(onSignedIn);
	done.current = onSignedIn;
	const ceremony = useRef(0);

	const verify = useCallback(async (response: AuthenticationResponseJSON) => {
		const { clientExtensionResults: _x, ...body } = response;
		const r = (await authClient.$fetch("/passkey/verify-authentication", {
			method: "POST",
			body: { response: body },
			throw: false,
		})) as { error: { message?: string } | null };
		if (r.error)
			throw new Error(r.error.message || "That passkey didn't work. Try an emailed code.");
		await done.current();
	}, []);

	const fetchOptions = useCallback(async () => {
		const r = await authClient.$fetch<PublicKeyCredentialRequestOptionsJSON>(
			"/passkey/generate-authenticate-options",
			{ method: "GET", throw: false },
		);
		options.current = r.data ? { json: r.data, at: Date.now() } : null;
		return options.current;
	}, []);

	/** Offers passkeys in the email field's autofill, where the browser can. */
	const listen = useCallback(async () => {
		const id = ++ceremony.current;
		const o = await fetchOptions();
		if (!o || id !== ceremony.current) return;
		if (!(await browserSupportsWebAuthnAutofill())) return;
		let response: AuthenticationResponseJSON;
		try {
			response = await startAuthentication({ optionsJSON: o.json, useBrowserAutofill: true });
		} catch {
			// Aborted because the button started its own prompt, the page moved on, or the browser
			// can't offer passkeys in autofill. Autofill is a convenience: it never shows an error.
			return;
		}
		if (id !== ceremony.current) return;
		setBusy(true);
		try {
			await verify(response);
		} catch (e) {
			setBusy(false);
			setError(messageOf(e));
			void listen();
		}
	}, [fetchOptions, verify]);

	useEffect(() => {
		const ok = browserSupportsWebAuthn() && window.isSecureContext;
		setSupported(ok);
		if (!ok) return;
		void listen();
		const timer = setInterval(() => void listen(), FRESH_FOR);
		return () => {
			clearInterval(timer);
			ceremony.current++;
		};
	}, [listen]);

	const signIn = useCallback(async () => {
		setError(null);
		setBusy(true);
		const id = ++ceremony.current;
		try {
			let o = options.current;
			if (!o || Date.now() - o.at > FRESH_FOR) o = await fetchOptions();
			if (!o)
				throw new Error("Mailroom couldn't start a passkey sign-in. Reload and try again.");
			// The autofill request (same challenge) is aborted by this one.
			const response = await startAuthentication({ optionsJSON: o.json });
			await verify(response);
		} catch (e) {
			if (id !== ceremony.current) return;
			setBusy(false);
			const name = e instanceof Error ? ((e as { cause?: Error }).cause?.name ?? e.name) : "";
			if (name !== "NotAllowedError" && name !== "AbortError")
				setError(messageOf(e) || "That passkey didn't work. Try an emailed code.");
			void listen();
		}
	}, [fetchOptions, verify, listen]);

	return { supported, busy, error, signIn };
}
