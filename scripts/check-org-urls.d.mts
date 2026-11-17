export const HANDLE: RegExp;
export function firstSegment(name: string): string;
export function listIn(source: string, name: string): Set<string>;
export function problems(o: {
	appFiles: string[];
	publicPaths: string[];
	appSections: ReadonlySet<string>;
	personPages: ReadonlySet<string>;
}): string[];
export function serverPaths(source: string): Set<string>;
