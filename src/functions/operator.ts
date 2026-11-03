import { createServerFn } from "@tanstack/react-start";
import { baseUrl, cfg } from "@/server/env";

/** Who runs this deployment, for the public About, Privacy and Terms pages (OPERATOR_NAME,
 * CONTACT_EMAIL). Empty when unset. */
export const operatorFn = createServerFn({ method: "GET" }).handler(() => {
	let host = "";
	try {
		host = new URL(baseUrl()).host;
	} catch {}
	return {
		name: cfg().OPERATOR_NAME?.trim() ?? "",
		contact: cfg().CONTACT_EMAIL?.trim() ?? "",
		host,
	};
});

export type Operator = Awaited<ReturnType<typeof operatorFn>>;

/** "that Ana Ruiz builds and runs for the love of it", or without a name. */
export const madeBy = (o: Operator) =>
	o.name
		? `that ${o.name} builds and runs for the love of it`
		: "built and run for the love of it";
