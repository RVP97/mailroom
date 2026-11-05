/**
 * The variables a saved reply or signature can hold, filled the same way on the server (when
 * one is sent) and in the browser (when a person picks one into the reply box to edit).
 */

export const VARIABLES = [
	{ key: "contact.first_name", label: "Their first name" },
	{ key: "contact.name", label: "Their name" },
	{ key: "contact.email", label: "Their email" },
	{ key: "agent.first_name", label: "Your first name" },
	{ key: "agent.name", label: "Your name" },
	{ key: "inbox.name", label: "The inbox's name" },
	{ key: "conversation.subject", label: "The subject" },
] as const;

/** A name's first word; nothing for a bare email address (someone who hasn't set a name). */
const firstName = (s: string | null | undefined) => {
	const first = (s ?? "").trim().split(/\s+/)[0]?.replace(/[<"]/g, "") ?? "";
	return first.includes("@") ? "" : first;
};

/** «Ana López <ana@…>» → Ana López; a bare address → "". */
export const displayName = (from: string) =>
	/^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "").trim() ?? "";

const address = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim();

/** {{contact.first_name}}, {{agent.name}}, {{inbox.name}}, {{conversation.subject}}…, each
 * with an optional fallback: {{contact.first_name|there}}. */
export function fillVariables(
	text: string,
	ctx: {
		contact?: string | null;
		agent?: string | null;
		inbox?: string | null;
		subject?: string | null;
		brand?: string | null;
	},
) {
	const name = ctx.contact ? displayName(ctx.contact) : "";
	const values: Record<string, string> = {
		"contact.name": name,
		"contact.first_name": firstName(name),
		"contact.email": ctx.contact ? address(ctx.contact) : "",
		"agent.name": ctx.agent ?? "",
		"agent.first_name": firstName(ctx.agent),
		"inbox.name": ctx.inbox ?? "",
		"conversation.subject": ctx.subject ?? "",
		"brand.name": ctx.brand ?? "",
	};
	return text.replace(
		/\{\{\s*([a-z_.]+)\s*(?:\|([^}]*))?\}\}/g,
		(all, key: string, fb?: string) => (key in values ? values[key] || (fb ?? "").trim() : all),
	);
}
