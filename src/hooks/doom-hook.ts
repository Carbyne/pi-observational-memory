/**
 * Main-agent doom-loop guard (opt-in, default OFF). Cheap models can collapse into an intra-message
 * token loop — emitting "duct duct…" / "BSRRductduct…" inside a single streamed assistant turn that
 * never terminates. This is the same pathology as the worker doom guard, but for the user's own
 * interactive session the escalation is deliberately gentler:
 *
 *   detection → **steer** (inject guidance, let it recover) → still looping → **abort** the turn.
 *
 * The worker guard silently self-aborts (its runs are disposable + retried). Here the first hit
 * nudges the model out of the loop and warns the user; only if it keeps repeating afterward is the
 * turn aborted — and then control returns to the user (no auto-continue). Detection reuses the same
 * conservative, prose-only detector as the workers (tool-call args are never scanned).
 *
 * Gated by `masterDoomGuard` (default false) because aborting a user's own turn must be opt-in.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRepetition, type DoomDetectConfig } from "../spawn/doom.js";
import type { Runtime } from "../runtime.js";

type DoomCtx = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	abort?: () => void;
};

const CHECK_STRIDE = 256;
const STEER_TEXT =
	"You appear to be repeating the same fragment over and over (a doom loop). Stop, discard the " +
	"broken repetition entirely, and continue concisely — or ask the user if you are unsure what they want.";

export function registerMasterDoomHook(pi: ExtensionAPI, runtime: Runtime): void {
	// Per-assistant-message state.
	let buf = "";
	let totalChars = 0;
	let sinceCheck = 0;
	let steered = false;
	let aborted = false;

	function reset(): void {
		buf = "";
		totalChars = 0;
		sinceCheck = 0;
		steered = false;
		aborted = false;
	}

	function cfg(): DoomDetectConfig {
		return {
			minRepeats: runtime.config.workerDoomMinRepeats,
			minChars: runtime.config.workerDoomMinChars,
			maxPeriod: runtime.config.workerDoomMaxPeriod,
		};
	}

	pi.on("turn_start", async () => {
		reset();
	});
	pi.on("message_start", async (event: any) => {
		const role = event?.message?.role;
		if (role === undefined || role === "assistant") reset();
	});

	pi.on("message_update", async (event: any, ctx: DoomCtx) => {
		if (!runtime.config.masterDoomGuard || aborted) return;
		const ae = event?.assistantMessageEvent;
		if (!ae) return;
		const type = ae.type as string;
		if (type !== "text_delta" && type !== "thinking_delta") return;
		const delta: string = typeof ae.delta === "string" ? ae.delta : "";
		if (delta.length === 0) return;

		const c = cfg();
		buf += delta;
		if (buf.length > c.minChars * 2) buf = buf.slice(buf.length - c.minChars);
		totalChars += delta.length;
		sinceCheck += delta.length;

		let detected = false;
		if (buf.length >= c.minChars && sinceCheck >= CHECK_STRIDE) {
			sinceCheck = 0;
			detected = detectRepetition(buf, c) !== null;
		}
		const overCap = totalChars > runtime.config.workerDoomMaxTurnChars;
		if (!detected && !overCap) return;
		const reason = overCap ? `runaway turn (${totalChars} chars)` : "a repeated fragment";

		if (!steered) {
			// Escalate step 1: nudge the model out of the loop, give it fresh runway.
			steered = true;
			buf = "";
			sinceCheck = 0;
			if (ctx.hasUI) {
				ctx.ui?.notify(
					`om: main agent looks stuck repeating (${reason}). Steering it out of the loop — set "masterDoomGuard": false to disable this guard.`,
					"warning",
				);
			}
			try {
				pi.sendUserMessage(STEER_TEXT, { deliverAs: "steer" });
			} catch {
				// best-effort steer
			}
			return;
		}

		// Escalate step 2: it kept repeating after the steer → abort the turn; control returns to the user.
		aborted = true;
		if (ctx.hasUI) {
			ctx.ui?.notify(
				`om: main agent still repeating after steering (${reason}) — aborted the turn. Review and re-prompt.`,
				"warning",
			);
		}
		try {
			ctx.abort?.();
		} catch {
			// best-effort
		}
	});
}
