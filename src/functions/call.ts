import { z } from "zod";
import { AccessError } from "@/server/access";
import { ApiError } from "@/server/errors";

/** Runs a server call, turning API and validation errors into the Response the dashboard shows. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ApiError) throw new Response(error.message, { status: error.status });
		if (error instanceof AccessError) throw new Response(error.message, { status: 403 });
		if (error instanceof z.ZodError) {
			const issue = error.issues[0];
			throw new Response(
				`${issue?.path.join(".") ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "Invalid"}`,
				{ status: 422 },
			);
		}
		throw error;
	}
}
