declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}

declare module "*.pem?raw" {
	const text: string;
	export default text;
}
