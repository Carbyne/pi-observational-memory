/**
 * Worker-side liveness (loaded into every worker via agent/index.ts). Two jobs, both driven by
 * pi's streaming `message_update` event — which fires mid-turn precisely BECAUSE workers stream
 * (the gateway's directHttpStreaming path), something the master cannot observe from a headless
 * `pi -p` child's stdout/stderr (all buffered until exit):
 *
 *  1. Heartbeat — touch the run's `.progress` file on run/turn/tool/stream activity so the master
 *     can tell an actively-working worker from one wedged on a provider that never answers.
 *  2. Doom guard — abort the worker's OWN turn the moment the model collapses into an intra-message
 *     token loop ("duct duct…") or a runaway-length turn. It writes a `.doom` sentinel + a live-log
 *     marker and calls ctx.abort(); the master retries / fails the run accordingly.
 *
 * Repetition detection runs on assistant TEXT and THINKING deltas only. Tool-call args (a
 * consolidator writing a large file streams as `toolcall_delta`) are deliberately EXCLUDED so a
 * legitimate big write is never mistaken for a loop — the doom symptom lives in the model's prose.
 *
 * No-op when OM_PROGRESS_PATH is unset (a worker launched standalone, outside the orchestrator).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { detectRepetition, type DoomDetectConfig } from "../src/spawn/doom.js";

function numEnv(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function writeEnsured(path: string, content: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf-8");
	} catch {
		// liveness must never affect the worker's behavior
	}
}

export function trackWorkerLiveness(pi: ExtensionAPI): void {
	const progressPath = process.env.OM_PROGRESS_PATH;
	if (!progressPath) return;
	const progressFile: string = progressPath;
	const doomPath = process.env.OM_DOOM_PATH;
	const logPath = process.env.OM_LOG_PATH;

	const doomEnabled = process.env.OM_DOOM === "1";
	const cfg: DoomDetectConfig = {
		minRepeats: numEnv("OM_DOOM_MIN_REPEATS", 32),
		minChars: numEnv("OM_DOOM_MIN_CHARS", 320),
		maxPeriod: numEnv("OM_DOOM_MAX_PERIOD", 32),
	};
	const maxTurnChars = numEnv("OM_DOOM_MAX_TURN_CHARS", 40_000);

	const HEARTBEAT_MS = 750;
	const CHECK_STRIDE = 256;
	let lastHeartbeat = 0;

	function heartbeat(phase: string, force = false): void {
		const now = Date.now();
		if (!force && now - lastHeartbeat < HEARTBEAT_MS) return;
		lastHeartbeat = now;
		writeEnsured(progressFile, JSON.stringify({ ts: now, phase }));
	}

	// Per-assistant-message repetition state.
	let buf = "";
	let totalChars = 0;
	let sinceCheck = 0;
	let abortedThisTurn = false;
	function resetMessage(): void {
		buf = "";
		totalChars = 0;
		sinceCheck = 0;
		abortedThisTurn = false;
	}

	function abortDoom(ctx: { abort?: () => void } | undefined, reason: string): void {
		if (abortedThisTurn) return;
		abortedThisTurn = true;
		if (doomPath) writeEnsured(doomPath, reason);
		if (logPath) {
			try {
				appendFileSync(logPath, `\n# om doom-guard: aborted — ${reason}\n`, "utf-8");
			} catch {
				// best-effort
			}
		}
		try {
			ctx?.abort?.();
		} catch {
			// best-effort
		}
	}

	pi.on("agent_start", async () => {
		heartbeat("agent_start", true);
	});
	pi.on("turn_start", async () => {
		heartbeat("turn_start", true);
	});
	pi.on("tool_execution_start", async () => {
		heartbeat("tool", true);
	});
	pi.on("message_start", async () => {
		resetMessage();
	});

	pi.on("message_update", async (event: any, ctx: any) => {
		heartbeat("stream"); // throttled, cheap liveness for any streaming activity
		if (!doomEnabled || abortedThisTurn) return;
		const ae = event?.assistantMessageEvent;
		if (!ae) return;
		const type = ae.type as string;
		if (type !== "text_delta" && type !== "thinking_delta") return;
		const delta: string = typeof ae.delta === "string" ? ae.delta : "";
		if (delta.length === 0) return;

		buf += delta;
		if (buf.length > cfg.minChars * 2) buf = buf.slice(buf.length - cfg.minChars);
		totalChars += delta.length;
		sinceCheck += delta.length;

		if (totalChars > maxTurnChars) {
			abortDoom(ctx, `runaway turn: ${totalChars} chars of generated text exceeded the ${maxTurnChars}-char cap`);
			return;
		}
		if (buf.length < cfg.minChars || sinceCheck < CHECK_STRIDE) return;
		sinceCheck = 0;
		const det = detectRepetition(buf, cfg);
		if (det) {
			abortDoom(
				ctx,
				`repetition collapse: ${det.periodLength}-char unit repeated ${det.repeats}+× ("${det.sample.slice(0, 24)}")`,
			);
		}
	});
}
