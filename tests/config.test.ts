import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULTS, normalizeSettingsConfig } from "../src/config.js";

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
	it("merges partial model entries over the defaults", () => {
		const normalized = normalizeSettingsConfig(
			{
				models: {
					observer: { provider: "yoda", id: "qwen3.8-27b" },
					consolidator: { id: "qwen3.8-27b" },
				},
			},
			DEFAULTS,
		);
		expect(normalized.models?.observer).toEqual({ provider: "yoda", id: "qwen3.8-27b", thinking: "low" });
		// consolidator keeps the default provider, takes the new id, keeps the default thinking.
		expect(normalized.models?.consolidator).toEqual({
			provider: DEFAULTS.models.consolidator.provider,
			id: "qwen3.8-27b",
			thinking: "medium",
		});
	});
});
