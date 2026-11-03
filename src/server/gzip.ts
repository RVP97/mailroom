/** JSON in and out of gzip (bodies in D1 take a fifth of the room). */
export async function gzipJson(value: unknown): Promise<Uint8Array> {
	const stream = new Blob([JSON.stringify(value)])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipJson<T>(bytes: ArrayBuffer | Uint8Array): Promise<T> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return JSON.parse(await new Response(stream).text()) as T;
}
