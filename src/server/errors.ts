/** An error the API returns as it is, in Resend's shape: { statusCode, name, message }. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly headers?: Record<string, string>,
	) {
		super(message);
		this.name = "ApiError";
	}

	toResponse(headers?: HeadersInit) {
		return Response.json(
			{ statusCode: this.status, name: this.code, message: this.message },
			{ status: this.status, headers: headers ?? this.headers },
		);
	}
}

export const validation = (message: string) => new ApiError(422, "validation_error", message);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
