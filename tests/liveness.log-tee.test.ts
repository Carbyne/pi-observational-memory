import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { trackWorkerLiveness } from "../agent/liveness.js";

// Minimal structural stand-in for pi's ExtensionAPI: capture handlers by event name so the test can
// fire streaming events at the worker-liveness extension and observe what it persists to disk.
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	return {
		on(event: string, handler: Handler): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		async fire(event: string, payload: unknown = {}): Promise<void> {
			for (const handler of handlers.get(event) ?? []) await handler(payload, {});
		},
	};
}

function textEvent(delta: string): unknown {
	return { assistantMessageEvent: { type: "text_delta", delta } };
}
function thinkingEvent(delta: string): unknown {
	return { assistantMessageEvent: { type: "thinking_delta", delta } };
}
function toolCallEvent(delta: string): unknown {
	return { assistantMessageEvent: { type: "toolcall_delta", delta } };
}

const ENV_KEYS = ["OM_PROGRESS_PATH", "OM_LOG_PATH", "OM_LOG_TEE"] as const;

describe("worker liveness: live log tee", () => {
	let dir: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-liveness-"));
		for (const k of ENV_KEYS) {
			saved.set(k, process.env[k]);
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		saved.clear();
		rmSync(dir, { recursive: true, force: true });
	});

	it("tees streamed text/thinking deltas to the run log, excluding tool-call args", async () => {
		const logPath = join(dir, "run.log");
		const progressPath = join(dir, "run.progress");
		process.env.OM_LOG_PATH = logPath;
		process.env.OM_PROGRESS_PATH = progressPath;

		const pi = fakePi();
		trackWorkerLiveness(pi as never);

		await pi.fire("message_update", textEvent("Hello "));
		await pi.fire("message_update", thinkingEvent("(ponder) "));
		await pi.fire("message_update", textEvent("world"));
		// A large tool-call arg stream must NOT leak into the transcript.
		await pi.fire("message_update", toolCallEvent('{"SECRET_FILE_BODY":"' + "x".repeat(2000)));
		// Boundary flush settles any throttled-but-pending prose.
		await pi.fire("turn_end");

		expect(existsSync(logPath)).toBe(true);
		const body = readFileSync(logPath, "utf-8");
		expect(body).toContain("Hello ");
		expect(body).toContain("(ponder) ");
		expect(body).toContain("world");
		expect(body).not.toContain("SECRET_FILE_BODY");
	});

	it("records tool/turn liveness in the heartbeat file", async () => {
		const logPath = join(dir, "run.log");
		const progressPath = join(dir, "run.progress");
		process.env.OM_LOG_PATH = logPath;
		process.env.OM_PROGRESS_PATH = progressPath;

		const pi = fakePi();
		trackWorkerLiveness(pi as never);

		await pi.fire("tool_execution_start", {}); // forced heartbeat → phase "tool"
		expect(existsSync(progressPath)).toBe(true);
		expect(readFileSync(progressPath, "utf-8")).toContain('"phase":"tool"');
	});

	it("does not tee the log when opted out via OM_LOG_TEE=0", async () => {
		const logPath = join(dir, "run.log");
		process.env.OM_LOG_PATH = logPath;
		process.env.OM_LOG_TEE = "0";
		process.env.OM_PROGRESS_PATH = join(dir, "run.progress");

		const pi = fakePi();
		trackWorkerLiveness(pi as never);

		await pi.fire("message_update", textEvent("SHOULD-NOT-APPEAR"));
		await pi.fire("turn_end");

		expect(existsSync(logPath)).toBe(false);
	});

	it("is a safe no-op when neither path is provided (standalone worker)", async () => {
		const pi = fakePi();
		trackWorkerLiveness(pi as never); // no env → registers but persists nothing
		await pi.fire("message_update", textEvent("nothing"));
		await pi.fire("turn_end");
		// No files created anywhere under dir.
		expect(existsSync(join(dir, "run.log"))).toBe(false);
	});
});
