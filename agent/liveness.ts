/**
 * Worker-side liveness (loaded into every worker via agent/index.ts). One job, driven by pi's
 * streaming events — which fire mid-turn precisely BECAUSE workers stream (the gateway's
 * directHttpStreaming path), something the master cannot observe from a headless `pi -p` child's
 * stdout/stderr (all buffered until exit):
 *
 *   Heartbeat — touch the run's `.progress` file on run/turn/tool/stream activity so the master can
 *   tell an actively-working worker from one wedged on a provider that never answers (the
 *   `workerProgressIdleTimeoutMs` watchdog keys on this file's mtime).
 *
 * Repetition / doom-loop detection is NOT done here: that is the job of the standalone
 * `pi-anti-doom-loop` extension, which OM loads into every worker via `-e` (see launch.ts). Keeping
 * this module to a pure heartbeat avoids duplicating loop logic inside observational-memory.
 *
 * No-op when OM_PROGRESS_PATH is unset (a worker launched standalone, outside the orchestrator).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

	const HEARTBEAT_MS = 750;
	let lastHeartbeat = 0;

	function heartbeat(phase: string, force = false): void {
		const now = Date.now();
		if (!force && now - lastHeartbeat < HEARTBEAT_MS) return;
		lastHeartbeat = now;
		writeEnsured(progressFile, JSON.stringify({ ts: now, phase }));
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
	// Any streamed output (text/thinking/tool-call) is liveness — the model is producing.
	pi.on("message_update", async () => {
		heartbeat("stream");
	});
}
