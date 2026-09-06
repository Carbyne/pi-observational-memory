/**
 * Resilient worker dispatch: one spawn attempt per try, re-spawning (within the SAME dispatch) on a
 * failed / timed-out run, up to `retries` extra attempts with linear backoff, before the caller
 * treats it as a single failure (e.g., one strike against the circuit breaker).
 *
 * A "clean" run means: exited 0, not watchdog-killed, and — if the caller passed `isSuccess` — that
 * predicate (e.g., the observer validates its result file) also passed. Per-attempt IPC files
 * (result/cost/progress) are cleared before each spawn so a retry never reads a stale artifact from
 * a prior attempt; the final successful attempt's files are left for the caller.
 *
 * Doom-loop handling is NOT here: the `pi-anti-doom-loop` extension (loaded into the worker via
 * `-e`) self-aborts a looping turn; an aborted worker then simply fails to produce its result file,
 * so `isSuccess` is false and this loop retries it — no doom-specific plumbing needed.
 */
import { spawnWorker, type WorkerExit } from "./launch.js";
import { clearWorkerAttemptFiles } from "./runs.js";
import type { Config } from "../config.js";

/** Human reason for a watchdog-killed worker run. */
export function timeoutMessage(
	role: string,
	reason: "wall" | "idle" | "progress",
	cfg: Config,
	logPath: string,
): string {
	const s = (n: number) => Math.round(n / 1000);
	if (reason === "wall") return `${role} timed out after ${s(cfg.workerTimeoutMs)}s (hard cap; see ${logPath})`;
	if (reason === "progress")
		return `${role} idle-timed out after ${s(cfg.workerProgressIdleTimeoutMs)}s with no worker activity — stalled provider or wedged run (see ${logPath})`;
	return `${role} idle-timed out after ${s(cfg.workerIdleTimeoutMs)}s with no output (stalled provider? see ${logPath})`;
}

export type WorkerRunOutcome = {
	exit: WorkerExit;
	/** How many attempts actually ran (>= 1). */
	attempts: number;
};

export type WorkerRunOptions = {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	memoryRoot: string;
	runId: string;
	logPath: string;
	progressPath: string;
	timeoutMs: number;
	idleTimeoutMs: number;
	progressIdleMs: number;
	retries: number;
	retryBackoffMs: number;
	/** Extra success gate beyond exit code (called only when the process exited clean otherwise). */
	isSuccess?: (exit: WorkerExit) => boolean;
};

/** Sleep `ms`, resolving early (true) if the signal aborts first. */
function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return new Promise<boolean>((resolve) => resolve(true));
	if (ms <= 0) return new Promise<boolean>((resolve) => resolve(false));
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve(false);
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			resolve(true);
		}
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

export async function runWorker(opts: WorkerRunOptions): Promise<WorkerRunOutcome> {
	const maxAttempts = Math.max(0, opts.retries) + 1;
	let attempts = 0;
	let exit: WorkerExit = { code: 1, signal: null, stderr: "" };

	while (attempts < maxAttempts) {
		if (attempts > 0) {
			const aborted = await sleepOrAbort(opts.retryBackoffMs * attempts, opts.signal);
			if (aborted) break;
		}
		attempts += 1;
		clearWorkerAttemptFiles(opts.memoryRoot, opts.runId);
		exit = await spawnWorker({
			argv: opts.argv,
			cwd: opts.cwd,
			env: opts.env,
			signal: opts.signal,
			logPath: opts.logPath,
			timeoutMs: opts.timeoutMs,
			idleTimeoutMs: opts.idleTimeoutMs,
			progressPath: opts.progressPath,
			progressIdleMs: opts.progressIdleMs,
		});
		const clean =
			exit.code === 0 &&
			exit.timeout === undefined &&
			(opts.isSuccess ? opts.isSuccess(exit) : true);
		if (clean) return { exit, attempts };
		if (opts.signal?.aborted) break;
	}

	return { exit, attempts };
}
