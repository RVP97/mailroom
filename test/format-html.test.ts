import { describe, expect, it } from "vitest";
import { formatHtml, htmlText } from "@/lib/format-html";

const pretty = (html: string) => htmlText(formatHtml(html));

describe("formatHtml", () => {
	it("puts one element to a line, children indented", () => {
		expect(
			pretty(
				'<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Hola</title></head><body><table><tr><td>Uno</td></tr></table></body></html>',
			),
		).toBe(
			[
				"<!DOCTYPE html>",
				'<html lang="es">',
				"  <head>",
				'    <meta charset="utf-8">',
				"    <title>Hola</title>",
				"  </head>",
				"  <body>",
				"    <table>",
				"      <tr>",
				"        <td>Uno</td>",
				"      </tr>",
				"    </table>",
				"  </body>",
				"</html>",
			].join("\n"),
		);
	});

	it("keeps short inline content on its parent's line and breaks long tags by attribute", () => {
		const style = "font-family:ui-sans-serif,system-ui,sans-serif;".repeat(3);
		expect(
			pretty(
				`<p>Hola <strong>Ana</strong>, <a href="https://x.mx">entra</a>.</p><div dir="ltr" lang="en" style="${style}">x</div>`,
			),
		).toBe(
			[
				'<p>Hola <strong>Ana</strong>, <a href="https://x.mx">entra</a>.</p>',
				"<div",
				'  dir="ltr"',
				'  lang="en"',
				`  style="${style}"`,
				">",
				"  x",
				"</div>",
			].join("\n"),
		);
	});

	it("opens minified CSS and keeps comments, stray tags and unclosed elements", () => {
		expect(
			pretty(
				"<style>.a{color:red;margin:0}@media (max-width:600px){.b{display:none}}</style><!--[if mso]><table><![endif]--></span><div><p>uno<p>dos</div>",
			),
		).toBe(
			[
				"<style>",
				"  .a {",
				"    color:red;",
				"    margin:0",
				"  }",
				"  @media (max-width:600px) {",
				"    .b {",
				"      display:none",
				"    }",
				"  }",
				"</style>",
				"<!--[if mso]><table><![endif]-->",
				"</span>",
				"<div>",
				"  <p>",
				"    uno",
				"    <p>dos</p>",
				"  </p>",
				"</div>",
			].join("\n"),
		);
	});

	it("lays out a 300 KB email quickly", () => {
		const row = '<tr><td style="padding:8px" class="c">Factura <b>A-1</b></td></tr>';
		const html = `<table>${row.repeat(4000)}</table>`;
		const start = performance.now();
		const lines = formatHtml(html);
		expect(lines.length).toBe(12_002);
		expect(performance.now() - start).toBeLessThan(500);
	});
});
