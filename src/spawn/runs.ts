/**
 * File-based IPC between the in-process orchestrator and subprocess workers.
 *
 * A subprocess cannot append to the master's ledger, so it writes its output to a transient
 * result file under `<project>/.memory/.runs/<runId>.json`. The orchestrator reads + validates
 * it after the process exits, then commits to the right tier (observations → ledger).
 *
 * Worker recordings themselves live in pi's GLOBAL session store, not here (decision 11).
 * `.memory/.runs/` clutter is not GC'd in v1 (accepted).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the observer model emits, before the orchestrator re-derives precise timestamp-ids. */
export type RawObservation = {
	timestamp: string; // "YYYY-MM-DD HH:MM"
	content: string;
};

export type ObserverRunResult = {
	observations: RawObservation[];
};

export function runsDir(root: string): string {
	return join(root, ".runs");
}

export function runResultPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.result.json`);
}

/**
 * Per-run live worker console log. The orchestrator tees the worker's stdout+stderr here as the
 * bytes arrive, so `tail -f .runs/<runId>.log` shows what a running worker is doing in real time
 * (the worker records its own session separately, but that is only inspectable once written).
 */
export function runLogPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.log`);
}

/**
 * Per-run liveness heartbeat. The WORKER extension touches this on agent/turn/streaming/tool
 * activity (NOT the master). The master polls its mtime to tell an actively-progressing worker
 * (streaming tokens, running tools) from one wedged on a provider that never answers — a signal
 * that stdout/stderr can't give for a headless `pi -p` run (which buffers all output to exit).
 */
export function runProgressPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.progress`);
}

/**
 * Remove a run's per-attempt IPC files before (re)spawning, so a retry never reads a stale
 * result/cost/progress from a previous attempt. Best-effort. The prompt + log seed are left
 * (log is re-seeded by spawnWorker; prompt is unchanged across attempts).
 */
export function clearWorkerAttemptFiles(root: string, runId: string): void {
	for (const p of [runResultPath(root, runId), runCostPath(root, runId), runProgressPath(root, runId)]) {
		try {
			rmSync(p, { force: true });
		} catch {
			// ignore
		}
	}
}

/**
 * Worker kickoff prompt. The subprocess reads this through pi's `@file` CLI support instead
 * of receiving the potentially large transcript as one argv element (Linux caps each argument
 * at MAX_ARG_STRLEN even when ARG_MAX is much larger).
 */
export function runPromptPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.prompt.md`);
}

export function writeWorkerPrompt(path: string, prompt: string): void {
	// Corrupted model output in a chunk can leave a NUL byte. The prompt no longer travels
	// through argv (see buildWorkerArgv), so spawn() can't reject it, but we still strip it so
	// the recorded worker session and the model input stay clean of malformed bytes.
	atomicWrite(path, prompt.replace(/\0/g, ""));
}

/**
 * Per-run cost handoff file. Written by the worker EXTENSION (never the model) from pi's
 * built-in `usage.cost.total`, read by the orchestrator after the process exits. Uniform
 * across roles — the consolidator has no observations result file but still reports cost here.
 */
export function runCostPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.cost.json`);
}

export type WorkerCostResult = {
	costUsd: number;
};

export function writeWorkerCost(path: string, cost: WorkerCostResult): void {
	atomicWrite(path, JSON.stringify(cost));
}

/** Best-effort read of a worker cost file; returns undefined on missing/malformed input. */
export function readWorkerCost(path: string): WorkerCostResult | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const cost = (raw as { costUsd?: unknown }).costUsd;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
		return { costUsd: cost };
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename) so a reader never sees a half-written file. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function isRawObservation(value: unknown): value is RawObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.timestamp === "string" && typeof v.content === "string" && v.content.trim().length > 0;
}

/** Parse + validate an observer result file. Throws on malformed input. */
export function readObserverResult(path: string): ObserverRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { observations?: unknown }).observations)) {
		throw new Error("observer result missing observations array");
	}
	const observations = (raw as { observations: unknown[] }).observations.filter(isRawObservation);
	return { observations };
}

export function writeObserverResult(path: string, result: ObserverRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}
