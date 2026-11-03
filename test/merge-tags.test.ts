import { describe, expect, it } from "vitest";
import { chipsHtml, contactGroups, labelOf, tagOf } from "@/lib/merge-tags";

describe("variables as chips", () => {
	it("names variables for people", () => {
		expect(labelOf("FIRST_NAME")).toBe("First name");
		expect(labelOf("contact.company_name")).toBe("Company name");
		expect(labelOf("event.room")).toBe("Event room");
		expect(labelOf("ORDER_ID")).toBe("Order id");
		const groups = contactGroups(["city"], {
			label: "Own",
			items: [{ key: "X", label: "Thing" }],
		});
		expect(labelOf("X", groups)).toBe("Thing");
		expect(groups.map((g) => g.label)).toEqual(["Own", "Contact"]);
	});

	it("writes tags back with their fallback, braces left out", () => {
		expect(tagOf("FIRST_NAME", "there")).toBe("{{{FIRST_NAME|there}}}");
		expect(tagOf("EMAIL", " ")).toBe("{{{EMAIL}}}");
		expect(tagOf("A", "x}}y")).toBe("{{{A|xy}}}");
	});

	it("turns tags in text into chips, not those inside a link's address", () => {
		const html = chipsHtml(
			'<p>Hi {{{FIRST_NAME|there}}} <a href="https://x.test/?e={{{EMAIL}}}">go</a></p>',
		);
		expect(html).toContain(
			'<span class="mt-chip" contenteditable="false" data-key="FIRST_NAME" data-fallback="there"',
		);
		expect(html).toContain(">First name</span>");
		expect(html).toContain('href="https://x.test/?e={{{EMAIL}}}"');
	});
});
