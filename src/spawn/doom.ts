/**
 * Pure token/character repetition detector for worker doom loops — NO pi imports, so it is unit-
 * testable and shared between the worker extension (agent/liveness.ts) and tests.
 *
 * The failure we target is a model collapsing into an intra-message token loop: it emits one short
 * unit over and over ("duct duct duct…") inside a SINGLE streamed assistant turn that never
 * terminates. This is distinct from repeated TOOL calls (what pi-anti-doom-loop targets, and which
 * our case has none of) — so we detect it on the streaming text/thinking deltas directly.
 *
 * Approach: look for the shortest period `p` such that the trailing `minChars` of the message are
 * tiled by that period with ≤ ~12% noise, at least `minRepeats` times. Ordinary prose/code never
 * tiles a 320-char window with a ≤32-char period, so healthy output is not flagged; a repetition
 * collapse always does. A separate hard character cap (checked by the caller) catches long loops
 * whose period is too big to tile cleanly.
 */

export type DoomDetectConfig = {
	/** Minimum whole repetitions of the period within the window. */
	minRepeats: number;
	/** Trailing window length (chars) that must be tiled to count as a loop. */
	minChars: number;
	/** Largest candidate period length to consider. */
	maxPeriod: number;
};

export type DoomDetection = {
	periodLength: number;
	repeats: number;
	sample: string;
};

const NOISE = 0.12;

/**
 * Detect a pathological repetition in the tail of `text`. Returns the detected period + repeat
 * count, or null when the text looks like normal (non-self-similar) output.
 */
export function detectRepetition(text: string, cfg: DoomDetectConfig): DoomDetection | null {
	const L = text.length;
	if (L < cfg.minChars) return null;

	const region = text.slice(L - cfg.minChars);
	// The period must divide the window into at least `minRepeats` copies → p ≤ minChars/minRepeats.
	const maxP = Math.min(cfg.maxPeriod, Math.floor(cfg.minChars / Math.max(2, cfg.minRepeats)));
	const allowedNoise = Math.floor(cfg.minChars * NOISE);

	for (let p = 1; p <= maxP; p++) {
		let mismatches = 0;
		for (let i = p; i < cfg.minChars; i++) {
			if (region[i] !== region[i - p]) {
				mismatches += 1;
				if (mismatches > allowedNoise) break;
			}
		}
		if (mismatches > allowedNoise) continue;

		const period = region.slice(0, p);
		// Ignore pure-whitespace periods: a run of newlines/spaces is benign, not a doom loop.
		if (period.trim().length === 0) continue;

		const repeats = Math.floor(cfg.minChars / p);
		if (repeats < cfg.minRepeats) continue;

		return { periodLength: p, repeats, sample: period };
	}
	return null;
}
