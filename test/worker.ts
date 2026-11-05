export { ChatRoom } from "@/server/chat-room";
export { Dispatcher } from "@/server/dispatcher";

export default {
	fetch: () => new Response("test worker"),
};
