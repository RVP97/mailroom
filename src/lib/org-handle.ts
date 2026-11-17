/**
 * An organization's short id, the first segment of its pages' URLs: mailroom.example.com/k7x2m9/
 * emails. Stored in `organization.handle`; random, never derived from the name (names change,
 * leak and collide), never changes, never reused. Its slug stays what it was (SES tenant names,
 * inbound addresses and the MCP's `organization` argument use it).
 *
 * The shape (exactly 6 lowercase letters and digits, at least one digit) is one no public page
 * has (/login, /about, /privacy), so the first segment of a path tells an organization from a
 * public page; scripts/check-org-urls.mjs (in the build) fails if a public path ever matches it.
 */
export const ORG_HANDLE = /^(?=[a-z]*[0-9])[a-z0-9]{6}$/;

export const isOrgHandle = (v: unknown): v is string => typeof v === "string" && ORG_HANDLE.test(v);

/** No look-alikes (0/o, 1/l/i): it's read off screens and typed by hand. 31 characters. */
export const HANDLE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** A new random handle (31^6 ≈ 887 million; the unique index settles a collision). */
export function newOrgHandle(): string {
	for (;;) {
		let out = "";
		while (out.length < 6) {
			const bytes = crypto.getRandomValues(new Uint8Array(12));
			for (const b of bytes) {
				// 248 = 31 × 8: the values above it would favor the first characters.
				if (b < 248 && out.length < 6) out += HANDLE_ALPHABET[b % 31];
			}
		}
		if (ORG_HANDLE.test(out)) return out;
	}
}
