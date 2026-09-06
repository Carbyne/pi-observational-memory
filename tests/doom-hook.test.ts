import { describe, expect, it, vi } from "vitest";

import { registerMasterDoomHook } from "../src/hooks/doom-hook.js";

function duct(n: number): string {
	return "duct".repeat(n);
}

function variedProse(n: number): string {
	// Distinct tokens each time → no short-period tiling the detector could latch onto.
	let s = "";
	for (let i = 0; i < n; i++) s += `tok${i} `;
	return s;
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
	return {
		config: {
			masterDoomGuard: true,
			workerDoomGuard: true,
			workerDoomMinRepeats: 32,
			workerDoomMinChars: 320,
			workerDoomMaxPeriod: 32,
			workerDoomMaxTurnChars: 40_000,
			...overrides,
		},
	} as any;
}

function makeHarness(runtime: any) {
	const handlers: Record<string, Array<(e: any, c: any) => Promise<void>>> = {};
	const sent: string[] = [];
	const notify = vi.fn();
	let aborts = 0;
	const pi: any = {
		on(ev: string, h: (e: any, c: any) => Promise<void>) {
			(handlers[ev] ??= []).push(h);
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};
	const ctx = { hasUI: true, ui: { notify }, abort: () => (aborts += 1) } as any;
	registerMasterDoomHook(pi, runtime);
	const fire = async (ev: string, event: any) => {
		for (const h of handlers[ev] ?? []) await h(event, ctx);
	};
	const delta = async (text: string, type = "text_delta") => {
		await fire("message_update", { assistantMessageEvent: { type, delta: text } });
	};
	return { fire, delta, sent, notify, get aborts() { return aborts; } };
}

describe("master doom hook: steer → abort ladder", () => {
	it("steers on the first collapse, aborts if it keeps repeating", async () => {
		const h = makeHarness(makeRuntime());
		await h.fire("message_start", { message: { role: "assistant" } });
		await h.delta(duct(300)); // 1200 chars of "duct"
		expect(h.sent.length).toBe(1); // steered
		expect(h.aborts).toBe(0); // not yet
		await h.delta(duct(300)); // still looping after the steer
		expect(h.aborts).toBe(1);
	});

	it("does nothing when masterDoomGuard is off (opt-in)", async () => {
		const h = makeHarness(makeRuntime({ masterDoomGuard: false }));
		await h.fire("message_start", { message: { role: "assistant" } });
		await h.delta(duct(400));
		await h.delta(duct(400));
		expect(h.sent.length).toBe(0);
		expect(h.aborts).toBe(0);
	});

	it("does not steer on ordinary varied prose", async () => {
		const h = makeHarness(makeRuntime());
		await h.fire("message_start", { message: { role: "assistant" } });
		await h.delta(variedProse(400));
		expect(h.sent.length).toBe(0);
		expect(h.aborts).toBe(0);
	});

	it("ignores tool-call arg deltas (a large file write is not a doom loop)", async () => {
		const h = makeHarness(makeRuntime());
		await h.fire("message_start", { message: { role: "assistant" } });
		// A consolidator-style huge tool-call payload would be a tight tiling of chars — but it is a
		// toolcall_delta, which the guard never scans.
		await h.delta(duct(2000), "toolcall_delta");
		expect(h.sent.length).toBe(0);
		expect(h.aborts).toBe(0);
	});

	it("aborts a runaway (over-char-cap) turn after one steer", async () => {
		const h = makeHarness(makeRuntime({ workerDoomMaxTurnChars: 1000 }));
		await h.fire("message_start", { message: { role: "assistant" } });
		await h.delta(variedProse(400)); // ~2000 chars, over the 1000 cap but NOT a repetition
		expect(h.sent.length).toBe(1); // first hit → steer
		await h.delta(variedProse(400)); // over cap again after the steer → abort
		expect(h.aborts).toBe(1);
	});
});
