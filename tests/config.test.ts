import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULTS, normalizeSettingsConfig } from "../src/config.js";

describe("normalizeSettingsConfig: worker watchdog caps", () => {
	it("has a non-zero wall cap and idle disabled by default", () => {
		// Wall cap dominates (20 min): a genuinely slow run behind a loaded provider must not be
		// killed by a too-eager watchdog.
		expect(DEFAULTS.workerTimeoutMs).toBe(20 * 60 * 1000);
		// Idle cap is off by default — it has false-killed slow runs; it is opt-in per setup.
		expect(DEFAULTS.workerIdleTimeoutMs).toBe(0);
	});

	it("accepts positive integers and leaves absent keys unset", () => {
		const normalized = normalizeSettingsConfig({ workerTimeoutMs: 30_000, workerIdleTimeoutMs: 9_000 }, DEFAULTS);
		expect(normalized.workerTimeoutMs).toBe(30_000);
		expect(normalized.workerIdleTimeoutMs).toBe(9_000);
		expect(normalizeSettingsConfig({}, DEFAULTS).workerTimeoutMs).toBeUndefined();
	});

	it("accepts 0 (disabled) but rejects negatives and non-integers", () => {
		expect(normalizeSettingsConfig({ workerTimeoutMs: 0 }, DEFAULTS).workerTimeoutMs).toBe(0);
		expect(normalizeSettingsConfig({ workerIdleTimeoutMs: 0 }, DEFAULTS).workerIdleTimeoutMs).toBe(0);
		expect(normalizeSettingsConfig({ workerTimeoutMs: -1 }, DEFAULTS).workerTimeoutMs).toBeUndefined();
		expect(normalizeSettingsConfig({ workerIdleTimeoutMs: 1.5 }, DEFAULTS).workerIdleTimeoutMs).toBeUndefined();
	});
});

describe("normalizeSettingsConfig: consolidator circuit breaker", () => {
	it("defaults to a 3-failure breaker with a 2-minute cooldown", () => {
		expect(DEFAULTS.consolidatorMaxConsecutiveFailures).toBe(3);
		expect(DEFAULTS.consolidatorRetryCooldownMs).toBe(120_000);
	});

	it("accepts positive integers and 0 (disabled), rejects negatives/non-integers", () => {
		const n = normalizeSettingsConfig({ consolidatorMaxConsecutiveFailures: 5, consolidatorRetryCooldownMs: 0 }, DEFAULTS);
		expect(n.consolidatorMaxConsecutiveFailures).toBe(5);
		expect(n.consolidatorRetryCooldownMs).toBe(0); // 0 disables the cooldown
		expect(normalizeSettingsConfig({ consolidatorMaxConsecutiveFailures: -1 }, DEFAULTS).consolidatorMaxConsecutiveFailures).toBeUndefined();
		expect(normalizeSettingsConfig({ consolidatorRetryCooldownMs: 2.5 }, DEFAULTS).consolidatorRetryCooldownMs).toBeUndefined();
	});
});

describe("normalizeSettingsConfig: workerExtensions", () => {
	it("defaults to no extra extensions", () => {
		const normalized = normalizeSettingsConfig({}, DEFAULTS);
		expect(normalized.workerExtensions).toBeUndefined();
		expect(DEFAULTS.workerExtensions).toEqual([]);
	});

	it("keeps only non-empty strings and expands a leading ~", () => {
		const normalized = normalizeSettingsConfig(
			{ workerExtensions: ["~/ext/a.ts", "/abs/b.ts", "", 42, null] },
			DEFAULTS,
		);
		expect(normalized.workerExtensions).toEqual([join(homedir(), "ext/a.ts"), "/abs/b.ts"]);
	});

	it("expands a bare ~ to the home dir", () => {
		const normalized = normalizeSettingsConfig({ workerExtensions: ["~"] }, DEFAULTS);
		expect(normalized.workerExtensions).toEqual([homedir()]);
	});

	it("ignores non-array workerExtensions", () => {
		const normalized = normalizeSettingsConfig({ workerExtensions: "~/x.ts" }, DEFAULTS);
		expect(normalized.workerExtensions).toBeUndefined();
	});
});

describe("normalizeSettingsConfig: models", () => {
	it("takes the full model name verbatim", () => {
		const normalized = normalizeSettingsConfig(
			{ models: { observer: { model: "yoda/qwen3.8-27b" } } },
			DEFAULTS,
		);
		expect(normalized.models?.observer).toEqual({ model: "yoda/qwen3.8-27b", thinking: "low" });
	});

	it("falls back to legacy provider/id concatenation", () => {
		const normalized = normalizeSettingsConfig(
			{ models: { observer: { provider: "openrouter", id: "z-ai/glm-5.3" } } },
			DEFAULTS,
		);
		expect(normalized.models?.observer?.model).toBe("openrouter/z-ai/glm-5.3");
	});

	it("keeps the default model when nothing is given", () => {
		const normalized = normalizeSettingsConfig({}, DEFAULTS);
		expect(normalized.models).toBeUndefined();
		expect(DEFAULTS.models.observer.model).toBe("openrouter/z-ai/glm-5.3");
	});
});

describe("normalizeSettingsConfig: worker liveness / doom guard / retry", () => {
	it("defaults: doom guard on/conservative, progress-idle 5min, retry off", () => {
		expect(DEFAULTS.workerDoomGuard).toBe(true);
		expect(DEFAULTS.masterDoomGuard).toBe(false); // main-agent guard is opt-in
		expect(DEFAULTS.workerDoomMinRepeats).toBe(32);
		expect(DEFAULTS.workerDoomMinChars).toBe(320);
		expect(DEFAULTS.workerDoomMaxPeriod).toBe(32);
		expect(DEFAULTS.workerDoomMaxTurnChars).toBe(40_000);
		expect(DEFAULTS.workerProgressIdleTimeoutMs).toBe(300_000);
		expect(DEFAULTS.workerRetries).toBe(0);
		expect(DEFAULTS.workerRetryBackoffMs).toBe(2_000);
	});

	it("normalizes the doom-guard + progress-idle + retry knobs, accepting 0 where meaningful", () => {
		const n = normalizeSettingsConfig(
			{
				workerDoomGuard: false,
				masterDoomGuard: true,
				workerDoomMinRepeats: 50,
				workerDoomMinChars: 500,
				workerDoomMaxPeriod: 16,
				workerDoomMaxTurnChars: 20_000,
				workerProgressIdleTimeoutMs: 0, // 0 disables
				workerRetries: 3,
				workerRetryBackoffMs: 1_000,
			},
			DEFAULTS,
		);
		expect(n.workerDoomGuard).toBe(false);
		expect(n.masterDoomGuard).toBe(true);
		expect(n.workerDoomMinRepeats).toBe(50);
		expect(n.workerDoomMinChars).toBe(500);
		expect(n.workerDoomMaxPeriod).toBe(16);
		expect(n.workerDoomMaxTurnChars).toBe(20_000);
		expect(n.workerProgressIdleTimeoutMs).toBe(0);
		expect(n.workerRetries).toBe(3);
		expect(n.workerRetryBackoffMs).toBe(1_000);
	});

	it("rejects negative / non-integer threshold values (kept at defaults)", () => {
		expect(normalizeSettingsConfig({ workerDoomMinRepeats: -1 }, DEFAULTS).workerDoomMinRepeats).toBeUndefined();
		expect(normalizeSettingsConfig({ workerRetries: 1.5 }, DEFAULTS).workerRetries).toBeUndefined();
		expect(normalizeSettingsConfig({ workerProgressIdleTimeoutMs: -5 }, DEFAULTS).workerProgressIdleTimeoutMs).toBeUndefined();
		expect(normalizeSettingsConfig({ workerDoomGuard: "yes" }, DEFAULTS).workerDoomGuard).toBeUndefined();
	});
});
