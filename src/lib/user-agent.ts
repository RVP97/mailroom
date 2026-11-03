/** A client's User-Agent as people say it: «Resend Node.js SDK 6.1.0», «curl 8.7.1». */
export function userAgentLabel(ua: string | null | undefined): string {
	if (!ua) return "Unknown";
	const sdk = /^resend-(node|python|php|ruby|go|java|rust|elixir|dotnet)[:/]v?([\d.]+)/i.exec(ua);
	if (sdk) {
		const name: Record<string, string> = {
			node: "Node.js",
			python: "Python",
			php: "PHP",
			ruby: "Ruby",
			go: "Go",
			java: "Java",
			rust: "Rust",
			elixir: "Elixir",
			dotnet: ".NET",
		};
		return `Resend ${name[(sdk[1] ?? "").toLowerCase()] ?? sdk[1]} SDK ${sdk[2]}`;
	}
	const known: [RegExp, string][] = [
		[/^curl\/([\d.]+)/i, "curl"],
		[/^node(?:-fetch)?\/?v?([\d.]+)?/i, "Node.js"],
		[/^undici/i, "Node.js"],
		[/^python-requests\/([\d.]+)/i, "Python requests"],
		[/^python-httpx\/([\d.]+)/i, "Python httpx"],
		[/^axios\/([\d.]+)/i, "axios"],
		[/^Go-http-client\/([\d.]+)/i, "Go"],
		[/^PostmanRuntime\/([\d.]+)/i, "Postman"],
		[/^Bun\/([\d.]+)/i, "Bun"],
		[/^Deno\/([\d.]+)/i, "Deno"],
		[/^Mozilla\//i, "Browser"],
	];
	for (const [re, name] of known) {
		const m = re.exec(ua);
		if (m) return m[1] ? `${name} ${m[1]}` : name;
	}
	return ua.split(/[\s(]/)[0]?.slice(0, 40) || ua.slice(0, 40);
}
