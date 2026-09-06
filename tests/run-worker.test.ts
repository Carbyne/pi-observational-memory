import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWorker } from "../src/spawn/run-worker.js";
import { runDoomPath, runLogPath, runProgressPath } from "../src/spawn/runs.js";

const NODE = process.execPath;
const BASE_ENV = { ...process.env } as NodeJS.ProcessEnv;

// A child that reads an attempt counter from env OM_MARK (a file OUTSIDE the per-attempt IPC files
// runWorker clears, so it persists across attempts within one dispatch). It fails while the count
// is below `failUntil`, then exits 0.
function flakyChild(failUntil: number): string[] {
	const script =
		`const fs=require("fs");const m=process.env.OM_MARK;let n=0;` +
		`try{n=Number(fs.readFileSync(m,"utf-8"))}catch{}n=n+1;fs.writeFileSync(m,String(n));` +
		`if(n<${failUntil}) process.exit(1);`;
	return [NODE, "-e", script];
}

function baseOpts(dir: string, runId: string) {
	return {
		cwd: dir,
		memoryRoot: dir,
		runId,
		logPath: runLogPath(dir, runId),
		progressPath: runProgressPath(dir, runId),
		timeoutMs: 0,
		idleTimeoutMs: 0,
		progressIdleMs: 0,
	};
}

describe("runWorker: retry resilience", () => {
	let dir: string;
	let marker: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-retry-"));
		marker = join(dir, "attempts.count");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("retries a failing worker and returns success after it recovers", async () => {
		const env = { ...BASE_ENV, OM_MARK: marker } as NodeJS.ProcessEnv;
		const { exit, attempts } = await runWorker({
			...baseOpts(dir, "cons-r1"),
			argv: flakyChild(2), // attempt 1 fails, attempt 2 succeeds
			env,
			retries: 2,
			retryBackoffMs: 5,
		});
		expect(exit.code).toBe(0);
		expect(exit.timeout).toBeUndefined();
		expect(attempts).toBe(2);
		expect(Number(readFileSync(marker, "utf-8"))).toBe(2);
	}, 10_000);

	it("reports exhausted attempts when the worker never succeeds", async () => {
		const env = { ...BASE_ENV, OM_MARK: marker } as NodeJS.ProcessEnv;
		const { exit, attempts } = await runWorker({
			...baseOpts(dir, "cons-r2"),
			argv: flakyChild(999),
			env,
			retries: 1, // 1 initial + 1 retry
			retryBackoffMs: 5,
		});
		expect(exit.code).toBe(1);
		expect(attempts).toBe(2);
	}, 10_000);

	it("does not retry when disabled (retries=0) — a single attempt", async () => {
		const env = { ...BASE_ENV, OM_MARK: marker } as NodeJS.ProcessEnv;
		const { attempts } = await runWorker({
			...baseOpts(dir, "cons-r3"),
			argv: flakyChild(999),
			env,
			retries: 0,
			retryBackoffMs: 0,
		});
		expect(attempts).toBe(1);
	}, 10_000);

	it("treats a doom sentinel as a non-clean run (surfaces doomReason)", async () => {
		const runId = "cons-r4";
		// Child exits 0 but writes the doom sentinel → runWorker must surface doomReason (not clean).
		const script = `const fs=require("fs");fs.writeFileSync(process.env.OM_DOOM,"repetition collapse: 5-char unit");process.exit(0)`;
		const env = { ...BASE_ENV, OM_DOOM: runDoomPath(dir, runId) } as NodeJS.ProcessEnv;
		const { exit, doomReason, attempts } = await runWorker({
			...baseOpts(dir, runId),
			argv: [NODE, "-e", script],
			env,
			retries: 0,
			retryBackoffMs: 0,
		});
		expect(exit.code).toBe(0);
		expect(attempts).toBe(1);
		expect(doomReason).toContain("repetition collapse");
	}, 10_000);

	it("isSuccess predicate gates a clean exit (e.g. missing result file forces a retry)", async () => {
		const env = { ...BASE_ENV, OM_MARK: marker } as NodeJS.ProcessEnv;
		// Child always exits 0 but never creates the result file → isSuccess false on attempt 1.
		const script = `process.exit(0)`;
		const { attempts } = await runWorker({
			...baseOpts(dir, "cons-r5"),
			argv: [NODE, "-e", script],
			env,
			retries: 2,
			retryBackoffMs: 5,
			isSuccess: () => false, // pretend the result file is never valid
		});
		// Clean exit but isSuccess false → keeps retrying until attempts are exhausted.
		expect(attempts).toBe(3); // 1 + 2 retries
	}, 10_000);
});
