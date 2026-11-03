import { createFileRoute } from "@tanstack/react-router";

const handle = async ({ request }: { request: Request }) =>
	(await import("@/server/auth")).auth().handler(request);

export const Route = createFileRoute("/api/auth/$")({
	server: { handlers: { GET: handle, POST: handle } },
});
