import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushToRoom } from "../src/server/chat-room";

type Bindings = { CHAT_ROOM: unknown };
const real = (env as unknown as Bindings).CHAT_ROOM;

/** A room namespace whose rooms throw these errors in turn, then work. */
function fakeRooms(...errors: Error[]) {
	let calls = 0;
	(env as unknown as Bindings).CHAT_ROOM = {
		idFromName: (name: string) => name,
		get: () => ({
			broadcast: async () => {
				const error = errors[calls++];
				if (error) throw error;
			},
		}),
	};
	return () => calls;
}

afterEach(() => {
	(env as unknown as Bindings).CHAT_ROOM = real;
	vi.restoreAllMocks();
});

describe("pushToRoom", () => {
	it("tries once more after Cloudflare's bare internal error, and then gets through", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = fakeRooms(new Error("internal error; reference = kok816c1l000lhkv34mvogi1"));
		await pushToRoom("conv_1", { type: "visitor", visitor: {} } as never);
		expect(calls()).toBe(2);
		expect(error).not.toHaveBeenCalled();
	});

	it("only warns when the blip lasts: the conversation is saved anyway", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const blip = () => new Error("internal error; reference = abc");
		const calls = fakeRooms(blip(), blip());
		await pushToRoom("conv_1", { type: "visitor", visitor: {} } as never);
		expect(calls()).toBe(2);
		expect(error).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
	});

	it("still reports a real bug, without retrying it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = fakeRooms(new TypeError("cannot read properties of undefined"));
		await pushToRoom("conv_1", { type: "visitor", visitor: {} } as never);
		expect(calls()).toBe(1);
		expect(error).toHaveBeenCalledOnce();
	});
});
