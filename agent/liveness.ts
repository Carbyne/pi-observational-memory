/**
 * Worker-side liveness (loaded into every worker via agent/index.ts). Two jobs, both driven by pi's
 * streaming events — which fire mid-turn precisely BECAUSE workers stream (the gateway's
 * directHttpStreaming path), something the master cannot observe from a headless `pi -p` child's
 * stdout/stderr (pi buffers its own stdout until exit, so a `tail -f` on the log is otherwise a
 * black box for a run that never reaches exit):
 *
 *   Heartbeat — touch the run's `.progress` file on run/turn/tool/stream activity so the master can
 *   tell an actively-working worker from one wedged on a provider that never answers (the
 *   `workerProgressIdleTimeoutMs` watchdog keys on this file's mtime).
 *
 *   Live log tee — append the streamed assistant **text/thinking** deltas to the run's `.log` as
 *   they arrive (throttled), so the log is a genuine real-time transcript and a worker that is
 *   later killed/timed-out still shows everything it streamed. `toolcall_delta` is intentionally
 *   NOT teed (a consolidator legitimately writing a large file streams it as tool-call args; we do
 *   not want the log filled with file bodies). Tool activity is still recorded via the heartbeat's
 *   `tool` phase on `tool_execution_start`. Opt out with `OM_LOG_TEE=0`.
 *
 * Repetition / doom-loop detection is NOT done here: that is the job of the standalone
 * `pi-anti-doom-loop` extension, which OM loads into every worker via `-e` (see launch.ts). Keeping
 * this module to liveness (heartbeat + log tee) avoids duplicating loop logic inside observational-memory.
 *
 * No-op heartbeat when OM_PROGRESS_PATH is unset (a worker launched standalone, outside the
 * orchestrator); the log tee separately no-ops when OM_LOG_PATH is unset or OM_LOG_TEE=0.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function ensureDir(path: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		// liveness must never affect the worker's behavior
	}
}

function writeEnsured(path: string, content: string): void {
	try {
		ensureDir(path);
		writeFileSync(path, content, "utf-8");
	} catch {
		// liveness must never affect the worker's behavior
	}
}

function appendEnsured(path: string, content: string): void {
	try {
		ensureDir(path);
		appendFileSync(path, content, "utf-8");
	} catch {
		// best-effort live log
	}
}

export function trackWorkerLiveness(pi: ExtensionAPI): void {
	const progressPath = process.env.OM_PROGRESS_PATH;
	const logPathRaw = process.env.OM_LOG_PATH;
	const logEnabled = logPathRaw !== undefined && process.env.OM_LOG_TEE !== "0";
	if (!progressPath && !logEnabled) return;
	const progressFile: string | undefined = progressPath;
	const logFile: string | undefined = logEnabled ? logPathRaw : undefined;

	const HEARTBEAT_MS = 750;
	const LOG_FLUSH_MS = 750;
	let lastHeartbeat = 0;
	let lastLogFlush = 0;
	let pendingLog = "";

	function heartbeat(phase: string, force = false): void {
		if (!progressFile) return;
		const now = Date.now();
		if (!force && now - lastHeartbeat < HEARTBEAT_MS) return;
		lastHeartbeat = now;
		writeEnsured(progressFile, JSON.stringify({ ts: now, phase }));
	}

	// Flush any accumulated streamed prose to the log. `force` bypasses the throttle (run/turn
	// boundaries) so a transcript never loses its tail when the worker is killed abruptly.
	function flushLog(force = false): void {
		if (!logFile || pendingLog === "") return;
		const now = Date.now();
		if (!force && now - lastLogFlush < LOG_FLUSH_MS) return;
		lastLogFlush = now;
		appendEnsured(logFile, pendingLog);
		pendingLog = "";
	}

	pi.on("agent_start", async () => {
		heartbeat("agent_start", true);
	});
	pi.on("turn_start", async () => {
		flushLog(true);
		heartbeat("turn_start", true);
	});
	pi.on("turn_end", async () => {
		flushLog(true);
	});
	pi.on("agent_end", async () => {
		flushLog(true);
	});
	pi.on("tool_execution_start", async () => {
		flushLog(true); // settle pending prose before a tool call so ordering stays readable
		heartbeat("tool", true);
	});
	// Any streamed output is liveness; text/thinking deltas are also teed to the live log.
	pi.on("message_update", async (event) => {
		heartbeat("stream");
		const ae = event.assistantMessageEvent;
		if (!ae || !logFile) return;
		// text_delta / thinking_delta are generated prose; toolcall_delta (file bodies etc.) is skipped.
		if (ae.type === "text_delta" || ae.type === "thinking_delta") {
			const delta = ae.delta;
			if (delta) pendingLog += delta;
			flushLog();
		}
	});
}
