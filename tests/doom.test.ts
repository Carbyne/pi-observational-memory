import { describe, expect, it } from "vitest";

import { detectRepetition, type DoomDetectConfig } from "../src/spawn/doom.js";

const CFG: DoomDetectConfig = { minRepeats: 32, minChars: 320, maxPeriod: 32 };

describe("detectRepetition (worker doom-loop detector)", () => {
	it("catches a word-repetition collapse (the duct-duct-duct signature)", () => {
		const text = "prefix prose then it breaks. " + "duct ".repeat(400);
		const det = detectRepetition(text, CFG);
		expect(det).not.toBeUndefined();
		expect(det!.periodLength).toBeLessThanOrEqual(6);
		expect(det!.repeats).toBeGreaterThanOrEqual(32);
		expect(det!.sample.trim().toLowerCase()).toContain("duct");
	});

	it("catches a single-character collapse", () => {
		const det = detectRepetition("ok " + "a".repeat(500), CFG);
		expect(det).not.toBeUndefined();
		expect(det!.periodLength).toBe(1);
	});

	it("catches a multi-char unit collapsing", () => {
		const det = detectRepetition("intro. " + "<|end|>".repeat(120), CFG);
		expect(det).not.toBeUndefined();
	});

	it("does NOT flag normal English prose", () => {
		const prose =
			"The consolidator folds observations into durable topic files under the memory root. " +
			"It updates the journey with a short descriptive segment and re-renders the index. " +
			"Healthy output should never be mistaken for a loop, even across many sentences. ".repeat(6);
		expect(detectRepetition(prose, CFG)).toBeNull();
	});

	it("does NOT flag varied (non-self-similar) output that is merely long", () => {
		let text = "";
		for (let i = 0; i < 200; i++) text += `item ${i}: value-${(i * 37) % 101} notes${i % 7}\n`;
		expect(detectRepetition(text, CFG)).toBeNull();
	});

	it("ignores pure-whitespace tiling (benign runs of newlines/spaces)", () => {
		expect(detectRepetition("x\n" + "\n".repeat(600), CFG)).toBeNull();
		expect(detectRepetition("y " + " ".repeat(600), CFG)).toBeNull();
	});

	it("returns null below the window length", () => {
		expect(detectRepetition("duct duct duct", CFG)).toBeNull();
	});

	it("is conservative: a large period that tiles fewer than minRepeats times is not flagged", () => {
		// period ~20 chars tiled 16× = 320 chars → repeats 16 < 32 → below the conservative bar.
		const unit = "alpha bravo charlie "; // 20 chars
		const text = unit.repeat(16);
		expect(text.length).toBeGreaterThanOrEqual(320);
		expect(detectRepetition(text, CFG)).toBeNull();
	});

	it("respects a stricter minRepeats (fewer copies no longer trips)", () => {
		const text = "duct ".repeat(70); // ~350 chars, period 5 → 70 copies
		expect(detectRepetition(text, CFG)).not.toBeUndefined();
		// Raise the bar beyond the actual copy count.
		const strict: DoomDetectConfig = { minRepeats: 200, minChars: 320, maxPeriod: 32 };
		expect(detectRepetition(text, strict)).toBeNull();
	});
});
