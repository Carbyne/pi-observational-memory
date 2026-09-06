import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { buildWorkerEnv } from "../src/spawn/launch.js";

describe("buildWorkerEnv(consolidator)", () => {
	it("sets role, run id, and the .memory sandbox root", () => {
		const env = buildWorkerEnv("consolidator", { memoryRoot: "/proj/.memory/sess-1", runId: "c1" });
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_RUN_ID).toBe("c1");
		expect(env.OM_MEMORY_DIR).toBe("/proj/.memory/sess-1");
	});
});

describe("registerConsolidatorTools (scoped to .memory/)", () => {
	let cwd: string;
	let memoryRoot: string;
	let tools: Map<string, any>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-tools-"));
		memoryRoot = join(cwd, ".memory");
		tools = new Map();
		const fakePi = { registerTool: (def: any) => tools.set(def.name, def) } as any;
		registerConsolidatorTools(fakePi, memoryRoot);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("registers the scoped tool belt (no terminal report tool)", () => {
		expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "write"].sort());
	});

	it("write then read a topic file", async () => {
		const res = await tools.get("write").execute("1", { path: "auth.md", content: "---\nid: auth\n---\nbody" });
		expect(res.content[0].text).toContain("Wrote auth.md");
		expect(readFileSync(join(memoryRoot, "auth.md"), "utf-8")).toContain("body");
		const read = await tools.get("read").execute("2", { path: "auth.md" });
		expect(read.content[0].text).toContain("body");
	});

	it("refuses to write or edit INDEX.md", async () => {
		const w = await tools.get("write").execute("1", { path: "INDEX.md", content: "x" });
		expect(w.content[0].text).toContain("generated automatically");
		expect(existsSync(join(memoryRoot, "INDEX.md"))).toBe(false);
	});

	it("rejects paths that escape .memory/", async () => {
		const r = await tools.get("write").execute("1", { path: "../escape.md", content: "x" });
		expect(r.content[0].text).toContain("escapes .memory/");
		expect(existsSync(join(cwd, "escape.md"))).toBe(false);
	});

	it("edit replaces an exact unique substring and rejects ambiguous matches", async () => {
		await tools.get("write").execute("1", { path: "t.md", content: "alpha beta alpha" });
		const ambiguous = await tools.get("edit").execute("2", { path: "t.md", oldText: "alpha", newText: "X" });
		expect(ambiguous.content[0].text).toContain("ambiguous");
		const ok = await tools.get("edit").execute("3", { path: "t.md", oldText: "beta", newText: "BETA" });
		expect(ok.content[0].text).toContain("Edited");
		expect(readFileSync(join(memoryRoot, "t.md"), "utf-8")).toBe("alpha BETA alpha");
	});

	it("ls and grep operate within .memory/", async () => {
		await tools.get("write").execute("1", { path: "auth.md", content: "uses JWT tokens" });
		await tools.get("write").execute("2", { path: "deploy.md", content: "uses fly.io" });
		const ls = await tools.get("ls").execute("3", {});
		expect(ls.content[0].text.split("\n").sort()).toEqual(["auth.md", "deploy.md"]);
		const grep = await tools.get("grep").execute("4", { pattern: "JWT" });
		expect(grep.content[0].text).toContain("auth.md:1");
	});
});

describe("registerConsolidatorTools: prompt/INDEX path namespace", () => {
	// Reproduces the production layout: the worker cwd + sandbox root is .memory/<sessionId>, but
	// the prompt/INDEX advertises topic paths project-relative (.memory/<sessionId>/x.md). The tool
	// belt must accept every equivalent address for the same file, so the model stops thrashing.
	const SID = "sess-abc123";
	let cwd: string;
	let memoryRoot: string;
	let tools: Map<string, any>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-ns-"));
		memoryRoot = join(cwd, ".memory", SID);
		mkdirSync(memoryRoot, { recursive: true });
		tools = new Map();
		registerConsolidatorTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, memoryRoot);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reads the same file whether addressed bare, project-relative, or absolute", async () => {
		await tools.get("write").execute("w", { path: "boot.md", content: "---\nid: boot\n---\nhello" });
		const forms = [
			"boot.md",
			".memory/boot.md",
			`.memory/${SID}/boot.md`, // the exact form renderIndexFile advertises
			`${SID}/boot.md`,
			join(memoryRoot, "boot.md"),
		];
		for (const path of forms) {
			const r = await tools.get("read").execute("r", { path });
			expect(r.content[0].text).toContain("hello");
		}
	});

	it("ls resolves the advertised .memory/<sessionId> prefix to the sandbox root (not 'empty')", async () => {
		await tools.get("write").execute("w", { path: "boot.md", content: "x" });
		for (const path of [undefined, ".", ".memory", `.memory/${SID}`, SID]) {
			const r = await tools.get("ls").execute("l", path === undefined ? {} : { path });
			expect(r.content[0].text).toContain("boot.md");
			expect(r.content[0].text).not.toContain("is empty");
		}
	});

	it("write in the advertised namespace lands inside the sandbox", async () => {
		await tools.get("write").execute("w", { path: `.memory/${SID}/new.md`, content: "n" });
		expect(existsSync(join(memoryRoot, "new.md"))).toBe(true);
	});

	it("still rejects escapes even when expressed in the advertised namespace", async () => {
		// strip-to-.memory/<sid> then .. must not smuggle an escape past the containment check
		const r = await tools.get("read").execute("r", { path: `.memory/${SID}/../../outside.txt` });
		expect(r.content[0].text).toMatch(/escapes|Error|no such/i);
		expect(existsSync(join(cwd, "outside.txt"))).toBe(false);
	});
});
