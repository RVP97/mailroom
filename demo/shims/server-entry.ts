/** TanStack Start's server entry, for the demo: the dashboard itself is the page, so nothing here. */
export default {
	fetch: async () => new Response("Not found", { status: 404 }),
};
