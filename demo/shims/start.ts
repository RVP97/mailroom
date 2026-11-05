/**
 * @tanstack/react-start for the demo: server functions run in the browser, against the demo's
 * in-memory database. The builder keeps TanStack's shape (middleware, validator, handler), so the
 * app's own src/functions modules run unchanged.
 */

type Ctx = Record<string, unknown>;
type Next = (o?: { context?: Ctx }) => Promise<unknown>;
type ServerStep = (a: {
	next: Next;
	context: Ctx;
	data: unknown;
	serverFnMeta: { name: string };
}) => Promise<unknown>;

interface Middleware {
	_deps: Middleware[];
	_step?: ServerStep;
}

export function createMiddleware(_opts?: unknown) {
	const mw = {
		_deps: [] as Middleware[],
		_step: undefined as ServerStep | undefined,
		middleware(deps: Middleware[]) {
			mw._deps = deps;
			return mw;
		},
		server(fn: ServerStep) {
			mw._step = fn;
			return mw;
		},
		client() {
			return mw;
		},
		validator() {
			return mw;
		},
		inputValidator() {
			return mw;
		},
	};
	return mw;
}

/** The middlewares in the order they run: each one's own dependencies first, once. */
function flatten(list: unknown[], out: Middleware[] = []): Middleware[] {
	for (const m of list as Middleware[]) {
		if (out.includes(m)) continue;
		flatten(m._deps ?? [], out);
		out.push(m);
	}
	return out;
}

const stepOf = (m: Middleware) => m._step;

type Validator = ((input: unknown) => unknown) | { parse: (input: unknown) => unknown } | undefined;

const validate = (v: Validator, input: unknown) =>
	!v ? input : typeof v === "function" ? v(input) : v.parse(input);

/** Every call goes through here, so the demo can show a moment of latency and count calls. */
export const demoCalls = { before: async (_name: string) => {} };

/** The demo's Vite plugin passes each function's export name first (demo/vite.config.ts). */
export function createServerFn(name: string | { method?: string }, opts?: { method?: string }) {
	const fnName = typeof name === "string" ? name : "anonymous";
	const _opts = typeof name === "string" ? opts : name;
	let mws: unknown[] = [];
	let validator: Validator;
	const builder = {
		middleware(list: unknown[]) {
			mws = list;
			return builder;
		},
		validator(v: Validator) {
			validator = v;
			return builder;
		},
		inputValidator(v: Validator) {
			validator = v;
			return builder;
		},
		handler(fn: (a: { data: unknown; context: Ctx }) => unknown) {
			const call = async (opts?: { data?: unknown }) => {
				await demoCalls.before(fnName);
				const data = validate(validator, opts?.data);
				const chain = flatten(mws);
				const run = async (i: number, context: Ctx): Promise<unknown> => {
					if (i >= chain.length) return fn({ data, context });
					const step = stepOf(chain[i]);
					if (!step) return run(i + 1, context);
					return step({
						data,
						context,
						serverFnMeta: { name: fnName },
						next: (o) => run(i + 1, { ...context, ...(o?.context ?? {}) }),
					});
				};
				const result = await run(0, {});
				// A real call's answer is serialized: callers get their own copy.
				return result === undefined ? result : structuredClone(result);
			};
			return Object.assign(call, { url: `/_demo/${fnName}`, method: _opts?.method ?? "GET" });
		},
	};
	return builder;
}

/** Runs the client side (the demo is only a browser). */
export function createIsomorphicFn() {
	let client: ((...a: unknown[]) => unknown) | undefined;
	const b = {
		server() {
			return b;
		},
		client(fn: (...a: unknown[]) => unknown) {
			client = fn;
			return Object.assign((...a: unknown[]) => client?.(...a), b);
		},
	};
	return b;
}

export function createStart(fn: () => unknown) {
	return { getOptions: fn };
}
