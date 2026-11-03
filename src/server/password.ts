/**
 * Password hashing with the Workers runtime's own PBKDF2 (Web Crypto), not Better Auth's default
 * scrypt, which runs in JavaScript and takes far longer than a request's CPU budget. 100,000
 * rounds of SHA-256 (the most Workers allows) take about 15 ms of CPU, once per sign-in or
 * password change. Stored as `pbkdf2-sha256$<rounds>$<salt>$<hash>`, base64.
 */

const ROUNDS = 100_000;
const PREFIX = "pbkdf2-sha256";

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, rounds: number) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password.normalize("NFKC")),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds },
		key,
		256,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, ROUNDS);
	return `${PREFIX}$${ROUNDS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }) {
	const [prefix, rounds, salt, expected] = hash.split("$");
	if (prefix !== PREFIX || !rounds || !salt || !expected) return false;
	const want = fromB64(expected);
	const got = await derive(password, fromB64(salt), Number(rounds));
	if (got.length !== want.length) return false;
	// Constant time: every byte is compared whatever the first difference.
	let diff = 0;
	for (let i = 0; i < got.length; i++) diff |= (got[i] ?? 0) ^ (want[i] ?? 0);
	return diff === 0;
}
