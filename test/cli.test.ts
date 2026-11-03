import { describe, expect, it } from "vitest";
// @ts-expect-error: the CLI is plain JavaScript with no types.
import { parseCsv } from "../cli/csv.mjs";

describe("the CLI's CSV reader", () => {
	it("reads quotes, commas, semicolons and newlines inside quotes", () => {
		expect(
			parseCsv(
				'email,first_name,notes\r\nana@x.test,Ana,"Likes ""quiet"" rooms, top floor"\n\nbo@x.test;Bo;"two\nlines"\n',
			),
		).toEqual([
			["email", "first_name", "notes"],
			["ana@x.test", "Ana", 'Likes "quiet" rooms, top floor'],
			["bo@x.test", "Bo", "two\nlines"],
		]);
	});
});
