import { describe, expect, it } from "vitest";
import { cleanRich, newBlock, parseDoc, renderEmail, starter } from "@/lib/email-doc";
import { createBroadcast, updateBroadcast } from "@/server/broadcasts";
import { serveMedia, uploadMedia } from "@/server/media";
import { createTemplate, publishTemplate } from "@/server/templates";
import { fakeOutside, seedOrg } from "./helpers";

describe("email designs", () => {
	it("keeps rich text to what emails need", () => {
		expect(
			cleanRich(
				'<div>Hi <b>Ana</b><script>x()</script></div><p onclick="x()">Go <a href="javascript:alert(1)">here</a> or <a href="https://hotel.test/?a=1&amp;b=2">there</a></p><span style="color:red">ok</span>',
			),
		).toBe(
			'<p>Hi <strong>Ana</strong></p><p>Go here or <a href="https://hotel.test/?a=1&amp;b=2">there</a></p>ok',
		);
	});

	it("cleans a saved design: unknown blocks go, values stay in range", () => {
		const doc = parseDoc({
			theme: { accent: "#ABC", width: 9000, font: "comic" },
			blocks: [
				{ type: "heading", html: "<h1>Hi</h1>", level: 7 },
				{ type: "nope" },
				{ type: "button", label: "Go", url: "hotel.test/rooms" },
				{
					type: "columns",
					columns: [[{ type: "columns" }, { type: "text", html: "<p>a</p>" }], []],
				},
			],
		});
		expect(doc?.theme).toMatchObject({ accent: "#aabbcc", width: 720, font: "modern" });
		expect(doc?.blocks.map((b) => b.type)).toEqual(["heading", "button", "columns"]);
		expect(doc?.blocks[0]).toMatchObject({ level: 1, html: "Hi" });
		expect(doc?.blocks[1]).toMatchObject({ url: "https://hotel.test/rooms" });
		// Columns hold no columns.
		expect(doc?.blocks[2]).toMatchObject({ columns: [[{ type: "text" }], []] });
	});

	it("renders an email inboxes show alike, with the unsubscribe link", () => {
		const doc = starter("newsletter", { name: "Harbor Inn", logo: "https://x.test/l.png" });
		const html = renderEmail(doc);
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain('src="https://x.test/l.png"');
		expect(html).toContain("{{{UNSUBSCRIBE_URL}}}");
		expect(html).toContain('class="mr-col"');
		expect(html).toContain("@media (max-width:620px)");
		for (const t of [
			"heading",
			"text",
			"button",
			"image",
			"divider",
			"spacer",
			"quote",
			"social",
			"footer",
			"html",
			"logo",
		] as const)
			expect(renderEmail({ ...doc, blocks: [newBlock(t)] })).toContain("<table");
	});
});

describe("designs on broadcasts and templates", () => {
	it("makes the HTML from the design, and HTML alone leaves the design", async () => {
		fakeOutside();
		const org = await seedOrg();
		const design = starter("announcement", { name: "Hotel" });
		const b = await createBroadcast(org.id, org.id, { name: "Nov", design });
		expect(b.design?.blocks).toHaveLength(design.blocks.length);
		expect(b.html).toContain("Introducing something new");
		const edited = await updateBroadcast(org.id, org.id, b.id, { html: "<p>by hand</p>" });
		expect(edited.design).toBeNull();
		expect(edited.html).toBe("<p>by hand</p>");
		await expect(updateBroadcast(org.id, org.id, b.id, { design: "junk" })).rejects.toThrow(
			/design/,
		);
	});

	it("copies a template's design into a broadcast, its variables filled", async () => {
		fakeOutside();
		const org = await seedOrg();
		const design = parseDoc({
			blocks: [{ type: "heading", html: 'Hello from {{{PLACE}}} "now"' }],
		});
		const t = await createTemplate(org.id, {
			name: "Hello",
			html: "",
			design,
			variables: [{ key: "PLACE", type: "string", fallback_value: 'the "roof"' }],
		});
		expect(t.draft.html).toContain("Hello from {{{PLACE}}}");
		await publishTemplate(org.id, t.id);
		const b = await createBroadcast(org.id, org.id, { template: { id: t.id } });
		expect(b.design?.blocks[0]).toMatchObject({ html: 'Hello from the "roof" "now"' });
		expect(b.html).toContain(`Hello from the "roof" "now"</h1>`);
	});
});

describe("email images", () => {
	it("keeps uploaded images and serves them to anyone", async () => {
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const { url } = await uploadMedia(
			"org1",
			`data:image/png;base64,${btoa(String.fromCharCode(...png))}`,
		);
		expect(url).toMatch(/^https:\/\/mailroom\.test\/media\/org1\/[a-f0-9]{32}\.png$/);
		const res = await serveMedia(new URL(url).pathname);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
		expect((await serveMedia("/media/org1/../x.png")).status).toBe(404);
		await expect(uploadMedia("org1", "data:image/png;base64,aGVsbG8=")).rejects.toThrow(
			/isn't what it says it is/,
		);
		await expect(uploadMedia("org1", "data:text/html;base64,aGVsbG8=")).rejects.toThrow(/PNG/);
	});
});
