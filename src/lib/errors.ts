/** The message of a server function's refusal (a Response thrown on the server) or an error. */
export async function errorMessage(error: unknown): Promise<string> {
	if (error instanceof Response)
		return (await error.text().catch(() => "")) || `Error ${error.status}`;
	if (error instanceof Error) return error.message;
	return String(error);
}
