import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/password";

describe("password hashing", () => {
	it("verifies the right password and refuses others", async () => {
		const hash = await hashPassword("correct horse battery");
		expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[^$]+\$[^$]+$/);
		expect(await verifyPassword({ hash, password: "correct horse battery" })).toBe(true);
		expect(await verifyPassword({ hash, password: "correct horse batterY" })).toBe(false);
	});

	it("salts every hash", async () => {
		expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
	});

	it("refuses hashes it doesn't know", async () => {
		expect(await verifyPassword({ hash: "scrypt:abc", password: "x" })).toBe(false);
	});
});
