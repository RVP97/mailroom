/**
 * The order of the Received list the person last looked at (this tab only), so a conversation's
 * page can step to the previous or next one and go back to the same filtered list.
 */

const KEY = "mailroom:received-order";

export type ReceivedOrder = { ids: string[]; search: Record<string, unknown> };

export function rememberOrder(order: ReceivedOrder) {
	try {
		sessionStorage.setItem(KEY, JSON.stringify(order));
	} catch {}
}

export function readOrder(): ReceivedOrder | null {
	try {
		const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
		return v && Array.isArray(v.ids) ? (v as ReceivedOrder) : null;
	} catch {
		return null;
	}
}

/** Where this conversation sits in that list, and its neighbors. */
export function neighbors(id: string) {
	const order = readOrder();
	const i = order ? order.ids.indexOf(id) : -1;
	if (!order || i < 0) return { index: -1, total: 0, prev: null, next: null, search: null };
	return {
		index: i,
		total: order.ids.length,
		prev: order.ids[i - 1] ?? null,
		next: order.ids[i + 1] ?? null,
		search: order.search,
	};
}
