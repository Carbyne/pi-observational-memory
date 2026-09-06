import { describe, expect, it } from "vitest";

import { Runtime } from "../src/runtime.js";

// The consolidator circuit-breaker state machine, exercised directly on Runtime (no subprocess):
// this is what stops a batch that fails every tick from hot-looping forever on an un-drainable pool.
describe("Runtime consolidator circuit breaker", () => {
	it("allows dispatch in the clean state", () => {
		const r = new Runtime();
		expect(r.consolidatorAutoDispatchAllowed(Date.now())).toBe(true);
	});

	it("stays below the breaker with a cooldown after a single failure", () => {
		const r = new Runtime();
		const before = Date.now();
		const outcome = r.registerConsolidatorFailure(/* max */ 3, /* cooldownMs */ 120_000);
		expect(outcome).toBe("cooldown");
		expect(r.consolidatorFailures).toBe(1);
		expect(r.consolidatorBlocked).toBe(false);
		// Immediately blocked by the cooldown, but allowed again once it elapses.
		expect(r.consolidatorAutoDispatchAllowed(before)).toBe(false);
		expect(r.consolidatorAutoDispatchAllowed(before + 120_001)).toBe(true);
	});

	it("opens the breaker at the consecutive-failure threshold", () => {
		const r = new Runtime();
		expect(r.registerConsolidatorFailure(3, 120_000)).toBe("cooldown");
		expect(r.registerConsolidatorFailure(3, 120_000)).toBe("cooldown");
		expect(r.registerConsolidatorFailure(3, 120_000)).toBe("blocked");
		expect(r.consolidatorBlocked).toBe(true);
		expect(r.consolidatorFailures).toBe(3);
		// Once blocked, no amount of elapsed time re-arms auto-dispatch — only a reset does.
		expect(r.consolidatorAutoDispatchAllowed(Date.now() + 10_000_000)).toBe(false);
	});

	it("reset (success / manual force) clears every bit of the breaker", () => {
		const r = new Runtime();
		r.registerConsolidatorFailure(3, 120_000);
		r.registerConsolidatorFailure(3, 120_000);
		r.registerConsolidatorFailure(3, 120_000); // blocked
		expect(r.consolidatorBlocked).toBe(true);
		r.resetConsolidatorBreaker();
		expect(r.consolidatorFailures).toBe(0);
		expect(r.consolidatorBlocked).toBe(false);
		expect(r.consolidatorNextRetryAt).toBe(0);
		expect(r.consolidatorAutoDispatchAllowed(Date.now())).toBe(true);
	});

	it("max=0 disables the breaker (never blocks), and cooldown=0 never paces", () => {
		const r = new Runtime();
		// max 0 → never opens; cooldown 0 → never paces. Re-dispatch behaves like pre-breaker.
		for (let i = 0; i < 10; i++) expect(r.registerConsolidatorFailure(0, 0)).toBe("none");
		expect(r.consolidatorBlocked).toBe(false);
		expect(r.consolidatorNextRetryAt).toBe(0);
		expect(r.consolidatorAutoDispatchAllowed(Date.now())).toBe(true);
	});
});
