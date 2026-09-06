/**
 * Subprocess worker launch — the yt-edit `pi -e <ext> -p` pattern (L2).
 *
 * NOT the subagents extension: that uses `--no-session --mode json`, which would defeat
 * decision 11's requirement that every worker be an ordinary recorded GLOBAL session. We
 * spawn a plain headless `pi` with no `--session-dir`, so the run is recorded under the
 * project path in `~/.pi/agent/sessions` and is openable in the session browser.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ConfiguredModel } from "../config.js";
import { runCostPath, runLogPath, runProgressPath, runResultPath } from "./runs.js";

/** Repo root = two levels up from src/spawn/. The shared agent extension lives at agent/index.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_EXTENSION_PATH = join(REPO_ROOT, "agent", "index.ts");

export function modelArg(model: ConfiguredModel): string {
	return model.model;
}

/** Resolve the `pi` entry point (subagents' trick), falling back to `pi` on PATH. */
export function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [] };
}

/**
 * The standalone doom-loop guard is a normal pi package that protects the process it is loaded
 * into. The master loads it automatically (it is in settings `packages`), but workers spawn with
 * `--no-extensions`, so user packages are NOT auto-loaded into them — OM re-includes the guard
 * here so a worker's own streamed turn is protected against the intra-token "duct duct…" collapse.
 * Resolution is best-effort: if the guard isn't installed, workers simply run without it (exactly
 * the pre-guard behavior). Cached after the first resolution.
 */
const GUARD_EXTENSION_NAME = "pi-anti-doom-loop";
let guardCache: string[] | undefined;

function piAgentHome(): string {
	const home = process.env["HOME"] ?? process.env["USERPROFILE"];
	return home ? join(home, ".pi", "agent") : join("~", ".pi", "agent");
}

function collectGuardDirs(dir: string, depth: number, out: string[]): void {
	if (depth > 4) return;
	let names: string[];
	try {
		names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === ".git" || name === "node_modules") continue;
		const full = join(dir, name);
		if (name === GUARD_EXTENSION_NAME) {
			const entry = join(full, "extensions", "index.ts");
			if (existsSync(entry)) out.push(entry);
			continue;
		}
		if (depth < 3) collectGuardDirs(full, depth + 1, out);
	}
}

function guardExtensionPaths(): string[] {
	// Escape hatch: mirror nothing (also lets a user opt a worker out of the guard without
	// uninstalling the package, and lets argv-shape tests be deterministic). Checked before the
	// cache so it applies even after a prior call populated `guardCache`.
	if (process.env["OM_DISABLE_GUARD_MIRROR"] === "1") return [];
	if (guardCache) return guardCache;
	const found: string[] = [];
	for (const root of [join(piAgentHome(), "git"), join(piAgentHome(), "extensions")]) {
		collectGuardDirs(root, 0, found);
	}
	guardCache = [...new Set(found)];
	return guardCache;
}

export function buildWorkerArgv(opts: {
	model: ConfiguredModel;
	sessionName: string;
	kickoffPromptPath: string;
	agentExtensionPath?: string;
	/**
	 * Extra extension files loaded into the worker via `-e` (e.g. a model-provider gateway
	 * extension). Workers run with `--no-extensions`, so any provider the worker model comes
	 * from must be loaded explicitly here or pi fails with "Model not found".
	 */
	extraExtensionPaths?: string[];
}): string[] {
	const pi = resolvePiBinary();
	const args = [
		...pi.baseArgs,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-builtin-tools",
		"--model",
		modelArg(opts.model),
	];
	if (opts.model.thinking) args.push("--thinking", opts.model.thinking);
	// Provider-registering extensions (workerExtensions) first, then the doom-loop guard, then the
	// worker's own role extension. Dedup so the guard is loaded once even if also listed explicitly.
	const loadOrder: string[] = [];
	for (const path of opts.extraExtensionPaths ?? []) loadOrder.push(path);
	for (const path of guardExtensionPaths()) if (!loadOrder.includes(path)) loadOrder.push(path);
	for (const path of loadOrder) args.push("-e", path);
	args.push("-e", opts.agentExtensionPath ?? AGENT_EXTENSION_PATH);
	args.push("-n", opts.sessionName);
	// `-p` is a boolean flag when followed by an @file argument. Pi reads the prompt from disk,
	// keeping arbitrarily large serialized transcript chunks out of the process argument list.
	// (The prompt content no longer touches argv, so it can never trip spawn()'s NUL-byte or
	// MAX_ARG_STRLEN limits; see writeWorkerPrompt for the NUL guard.)
	args.push("-p", `@${opts.kickoffPromptPath}`);
	return [pi.command, ...args];
}

export type WorkerExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	/** Why the watchdog killed the run (undefined when the worker exited on its own). */
	timeout?: "wall" | "idle" | "progress";
};

/**
 * Spawn a headless worker; resolve when it exits (or when the watchdog kills it). Workers run in
 * their master session's `.memory/<sessionId>/` root (not the project cwd) so pi keys the run into
 * a distinct global session bucket and it never clutters the project's `/resume` picker. The root
 * is ensured to exist before spawn — `spawn()` would ENOENT otherwise (the memory root is created
 * lazily on first durable write when there is no parent to seed).
 *
 * Observability + liveness:
 *   - When `logPath` is set, the worker's stdout AND stderr are teed to it as the bytes arrive, so
 *     `tail -f <logPath>` shows a running worker in real time (previously stdout was discarded and
 *     stderr only returned at exit — a stuck worker was a black box).
 *   - `timeoutMs` is a hard wall-clock cap; `idleTimeoutMs` kills a run that produced no output for
 *     that long (a stalled provider). Either fires a SIGTERM then SIGKILL and resolves with a
 *     `timeout` reason so the caller frees the worker's slot / consolidator flag instead of the
 *     pipeline wedging forever on a hung run.
 */
export function spawnWorker(opts: {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	logPath?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	/** Path of the worker's liveness heartbeat file (written by the worker extension). */
	progressPath?: string;
	/** Kill the run if the heartbeat file has not advanced for this long; 0/undefined disables. */
	progressIdleMs?: number;
}): Promise<WorkerExit> {
	const [command, ...rest] = opts.argv;
	mkdirSync(opts.cwd, { recursive: true });
	// Truncate/seed the live log up front so a `tail -f` that races the spawn still attaches, and
	// so a stale file from a reused runId never mixes runs. A failed seed disables the live view for
	// this run (logging must never affect the worker's behavior).
	let logPath = opts.logPath;
	if (logPath) {
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			writeFileSync(logPath, `# om worker ${command} ${rest.join(" ")}\n`, "utf-8");
		} catch {
			logPath = undefined;
		}
	}
	return new Promise<WorkerExit>((resolvePromise) => {
		const proc = spawn(command, rest, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		let settled = false;
		let timeoutReason: WorkerExit["timeout"];

		const tee = (stream: "stdout" | "stderr") => (d: Buffer): void => {
			const text = d.toString();
			if (stream === "stderr") stderr += text;
			if (logPath) {
				try {
					appendFileSync(logPath, text, "utf-8");
				} catch {
					// best-effort live log
				}
			}
			resetIdle();
		};
		proc.stdout?.on("data", tee("stdout"));
		proc.stderr?.on("data", tee("stderr"));

		// Progress-idle cap: the worker's own heartbeat file mtime is the liveness signal (a headless
		// run emits no stdout/stderr until exit, so bytes can't tell alive-from-wedged). Reset baseline
		// to spawn time so a worker that never heartbeats is also eventually reclaimed.
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		const clearProgress = (): void => {
			if (progressTimer !== undefined) clearInterval(progressTimer);
		};
		const spawnTime = Date.now();
		if (opts.progressIdleMs && opts.progressIdleMs > 0 && opts.progressPath) {
			const progressPath = opts.progressPath;
			const limit = opts.progressIdleMs;
			progressTimer = setInterval(() => {
				let last = spawnTime;
				try {
					const st = statSync(progressPath);
					if (st.mtimeMs > 0) last = st.mtimeMs;
				} catch {
					// not created yet → treat as spawnTime (never heartbeated)
				}
				if (Date.now() - last > limit) {
					timeoutReason = "progress";
					kill();
				}
			}, 1000);
			progressTimer.unref?.();
		}

		const finish = (result: WorkerExit): void => {
			if (settled) return;
			settled = true;
			clearHard();
			clearIdle();
			clearProgress();
			if (logPath && result.timeout) {
				try {
					appendFileSync(
						logPath,
						`\n# om watchdog: killed (${result.timeout === "wall" ? "hard timeout" : result.timeout === "progress" ? "progress/idle (no worker activity)" : "idle timeout"})\n`,
						"utf-8",
					);
				} catch {
					// ignore
				}
			}
			resolvePromise(result);
		};

		const kill = (): void => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 3000).unref?.();
		};

		// Hard wall-clock cap (catches a run that keeps producing output but never finishes — a
		// model spinning in a tool loop).
		let hardTimer: ReturnType<typeof setTimeout> | undefined;
		const clearHard = (): void => {
			if (hardTimer !== undefined) clearTimeout(hardTimer);
		};
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			hardTimer = setTimeout(() => {
				timeoutReason = "wall";
				kill();
			}, opts.timeoutMs);
			hardTimer.unref?.();
		}

		// Idle cap (catches a stalled provider / hung fetch: no bytes at all). Reset on every chunk.
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const clearIdle = (): void => {
			if (idleTimer !== undefined) clearTimeout(idleTimer);
		};
		const armIdle = (): void => {
			if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return;
			clearIdle();
			idleTimer = setTimeout(() => {
				timeoutReason = "idle";
				kill();
			}, opts.idleTimeoutMs);
			idleTimer.unref?.();
		};
		const resetIdle = (): void => armIdle();
		armIdle();

		proc.on("error", () => finish({ code: 1, signal: null, stderr: stderr || "spawn error" }));
		proc.on("close", (code, signal) =>
			finish({ code, signal, stderr, timeout: timeoutReason }),
		);

		if (opts.signal) {
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener("abort", kill, { once: true });
		}
	});
}

export type ObserverLaunchEnv = {
	/** Absolute `.memory/<sessionId>/` root — IPC files and the consolidator sandbox live here. */
	memoryRoot: string;
	runId: string;
};

/**
 * Build the env a worker subprocess needs to write its result file. The chunk is loaded by pi
 * from an `@file` CLI argument and still becomes the worker's recorded user message.
 */
export function buildWorkerEnv(role: "observer" | "consolidator", opts: ObserverLaunchEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		OM_RESULT_PATH: runResultPath(opts.memoryRoot, opts.runId),
		// Per-run cost handoff: the worker extension writes pi's built-in usage.cost.total here.
		OM_COST_PATH: runCostPath(opts.memoryRoot, opts.runId),
		// Sandbox root for the consolidator's scoped file tools (design risk 6).
		OM_MEMORY_DIR: opts.memoryRoot,
		// Liveness heartbeat the worker extension writes; the master polls its mtime.
		OM_PROGRESS_PATH: runProgressPath(opts.memoryRoot, opts.runId),
		OM_LOG_PATH: runLogPath(opts.memoryRoot, opts.runId),
	};
	return env;
}
