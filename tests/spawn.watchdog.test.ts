import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spawnWorker } from "../src/spawn/launch.js";
import { runLogPath } from "../src/spawn/runs.js";

// The node binary running vitest — used to spawn trivial child scripts so these tests exercise
// the real spawnWorker path without depending on a `pi` model/provider.
const NODE = process.execPath;
const BASE_ENV = { ...process.env } as NodeJS.ProcessEnv;

function child(script: string): string[] {
	return [NODE, "-e", script];
}

describe("spawnWorker: live log tee", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-watchdog-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("tees stdout and stderr to the per-run log as a worker runs", async () => {
		const logPath = runLogPath(dir, "obs-1");
		const exit = await spawnWorker({
			argv: child(`console.log("HELLO-STDOUT"); console.error("HELLO-STDERR")`),
			cwd: dir,
			env: BASE_ENV,
			logPath,
		});
		expect(exit.code).toBe(0);
		expect(exit.timeout).toBeUndefined();
		// stderr is still returned for the caller's inline error message...
		expect(exit.stderr).toContain("HELLO-STDERR");
		// ...and BOTH streams are teed live to the run log, alongside the spawn header.
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("HELLO-STDOUT");
		expect(log).toContain("HELLO-STDERR");
		expect(log.startsWith("# om worker")).toBe(true);
	});

	it("truncates a stale log for a reused runId (no cross-run bleed)", async () => {
		const logPath = runLogPath(dir, "obs-dup");
		// seed a stale file with content that the second run must never show
		await spawnWorker({ argv: child(`console.log("FIRST-RUN-MARKER")`), cwd: dir, env: BASE_ENV, logPath });
		expect(readFileSync(logPath, "utf-8")).toContain("FIRST-RUN-MARKER");
		await spawnWorker({ argv: child(`console.log("SECOND-RUN-MARKER")`), cwd: dir, env: BASE_ENV, logPath });
		const log = readFileSync(logPath, "utf-8");
		expect(log).toContain("SECOND-RUN-MARKER");
		expect(log).not.toContain("FIRST-RUN-MARKER");
	});

	it("works with no logPath (stdout/stderr not persisted)", async () => {
		const exit = await spawnWorker({ argv: child(`console.log("x")`), cwd: dir, env: BASE_ENV });
		expect(exit.code).toBe(0);
		expect(exit.timeout).toBeUndefined();
	});
});

describe("spawnWorker: watchdog kills", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-watchdog2-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("hard-caps a silent-but-alive run (wall timeout, idle disabled)", async () => {
		const started = Date.now();
		const exit = await spawnWorker({
			argv: child(`setTimeout(() => {}, 1e7)`), // stays alive, emits nothing
			cwd: dir,
			env: BASE_ENV,
			timeoutMs: 250,
			idleTimeoutMs: 0,
		});
		const elapsed = Date.now() - started;
		expect(exit.timeout).toBe("wall");
		// The watchdog fired near the configured cap, not only after the child's 1e7s timer.
		expect(elapsed).toBeLessThan(5000);
	}, 10_000);

	it("idle-caps a run that produces no output (idle timeout, wall disabled)", async () => {
		const started = Date.now();
		const exit = await spawnWorker({
			argv: child(`setTimeout(() => {}, 1e7)`),
			cwd: dir,
			env: BASE_ENV,
			timeoutMs: 0,
			idleTimeoutMs: 250,
		});
		const elapsed = Date.now() - started;
		expect(exit.timeout).toBe("idle");
		expect(elapsed).toBeLessThan(5000);
	}, 10_000);

	it("does NOT idle-kill a run that keeps emitting output (activity resets the idle timer)", async () => {
		const logPath = runLogPath(dir, "obs-active");
		// Prints every 80ms for ~600ms — comfortably past the 250ms idle cap, so idle must never
		// fire; it exits cleanly before the (disabled) wall cap.
		const exit = await spawnWorker({
			argv: child(
				`let n=0; const t=setInterval(() => console.log("tick"+(n++)), 80); setTimeout(() => clearInterval(t), 600)`,
			),
			cwd: dir,
			env: BASE_ENV,
			logPath,
			timeoutMs: 0,
			idleTimeoutMs: 250,
		});
		expect(exit.timeout).toBeUndefined();
		expect(exit.code).toBe(0);
		expect(readFileSync(logPath, "utf-8")).toContain("tick5");
	}, 10_000);

	it("appends a watchdog marker to the live log on a timeout kill", async () => {
		const logPath = runLogPath(dir, "obs-wall");
		const exit = await spawnWorker({
			argv: child(`setTimeout(() => {}, 1e7)`),
			cwd: dir,
			env: BASE_ENV,
			logPath,
			timeoutMs: 200,
			idleTimeoutMs: 0,
		});
		expect(exit.timeout).toBe("wall");
		expect(readFileSync(logPath, "utf-8")).toContain("# om watchdog: killed (hard timeout)");
	}, 10_000);

	it("leaves the log untouched by any marker on a clean exit", async () => {
		const logPath = runLogPath(dir, "obs-clean");
		const exit = await spawnWorker({ argv: child(`console.log("done")`), cwd: dir, env: BASE_ENV, logPath });
		expect(exit.code).toBe(0);
		expect(existsSync(logPath)).toBe(true);
		expect(readFileSync(logPath, "utf-8")).not.toContain("om watchdog");
	});
});
