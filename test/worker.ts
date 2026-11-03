export { Dispatcher } from "@/server/dispatcher";

export default {
	fetch: () => new Response("test worker"),
};
