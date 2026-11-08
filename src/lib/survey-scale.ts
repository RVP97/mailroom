/** A survey's answers and how they look in an email (the editor's block, the follow-up email). */

export type ScaleSurvey = {
	kind: string;
	options: string[];
	low_label?: string | null;
	high_label?: string | null;
};

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The answers a survey takes, as [value, label]: 0-10, 1-5, or its options. */
export function scaleOf(s: Pick<ScaleSurvey, "kind" | "options">): [number, string][] {
	if (s.kind === "nps") return Array.from({ length: 11 }, (_, i) => [i, String(i)]);
	if (s.kind === "csat") return [1, 2, 3, 4, 5].map((i) => [i, String(i)]);
	return s.options.map((o, i) => [i, o]);
}

/** An NPS answer's group. */
export const npsGroup = (score: number) =>
	score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor";

/** The answers as one row (or a list, for a choice) of email-safe links. */
export function scaleLinks(
	s: ScaleSurvey,
	href: (value: number) => string,
	t: { font: string; size: number; color: string; border: string; radius: number; align: string },
) {
	const scale = scaleOf(s);
	if (s.kind === "choice")
		return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${scale
			.map(
				([v, l], i) =>
					`<tr><td style="padding:${i ? 8 : 0}px 0 0;"><a href="${href(v)}" style="display:block;border:1px solid ${t.border};border-radius:${t.radius}px;padding:12px 16px;font-family:${t.font};font-size:${t.size}px;line-height:1.3;font-weight:500;color:${t.color};text-decoration:none;text-align:${t.align};">${esc(l)}</a></td></tr>`,
			)
			.join("")}</table>`;
	const wide = s.kind === "nps";
	const cells = scale
		.map(
			([v, l]) =>
				`<td style="padding:0 ${wide ? 2 : 4}px;" width="${Math.floor(100 / scale.length)}%"><a href="${href(v)}" style="display:block;border:1px solid ${t.border};border-radius:${Math.min(t.radius, 8)}px;padding:${wide ? 10 : 12}px 0;font-family:${t.font};font-size:${t.size}px;line-height:1;font-weight:600;color:${t.color};text-decoration:none;text-align:center;">${l}</a></td>`,
		)
		.join("");
	const ends =
		s.low_label || s.high_label
			? `<tr><td colspan="${scale.length}" style="padding:8px 2px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-family:${t.font};font-size:12px;color:${t.color};opacity:.7;text-align:left;">${esc(s.low_label ?? "")}</td><td style="font-family:${t.font};font-size:12px;color:${t.color};opacity:.7;text-align:right;">${esc(s.high_label ?? "")}</td></tr></table></td></tr>`
			: "";
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr>${cells}</tr>${ends}</table>`;
}
