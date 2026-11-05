/** @sentry/cloudflare for the demo: the Worker's handlers as they are, without Sentry. */
export const withSentry = <T>(_options: unknown, handler: T) => handler;
export const instrumentDurableObjectWithSentry = <T>(_options: unknown, cls: T) => cls;
export const captureConsoleIntegration = (_o?: unknown) => ({ name: "CaptureConsole" });
export type CloudflareOptions = Record<string, unknown>;
