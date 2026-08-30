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
