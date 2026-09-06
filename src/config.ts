import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	/** Full model name — passed verbatim as pi's `--model` value (e.g. `yoda/qwen3.8-27b`). */
	model: string;
	/** Legacy: provider prefix, used only to build `model` when it is not given. */
	provider?: string;
	/** Legacy: model id, used only to build `model` when it is not given. */
	id?: string;
	thinking?: ModelThinkingLevel;
}

export interface Config {
	/** Raw-history token size of one observation chunk (fixed boundary). */
	chunkTokens: number;
	/** Overlap between adjacent chunks; default 0 in v1. */
	chunkOverlapTokens: number;
	/** Target size of the active observation pool; the buffer drains back toward this after consolidation. */
	poolTargetTokens: number;
	/** Active-pool token count that triggers a consolidation (200% of target). */
	consolidateAtPoolTokens: number;
	/** Live context-window usage that triggers compaction. */
	compactAtContextTokens: number;
	/** Verbatim raw tail kept after the cutoff; snaps to a chunk boundary. */
	tailTokens: number;
	/**
	 * Target size of `.memory/JOURNEY.md`, the running descriptive project history the
	 * consolidator appends to and pushes into every compaction block. When the file grows past
	 * this, the consolidator compresses its oldest entries (recent history stays detailed).
	 */
	journeyTargetTokens: number;
	/** Max simultaneous in-flight observer subprocesses. */
	observerConcurrency: number;
	models: {
		observer: ConfiguredModel;
		consolidator: ConfiguredModel;
	};
	/**
	 * Extra extension files loaded into every worker subprocess via `-e` (in addition to the
	 * shared worker extension). Needed when worker models come from a provider registered by an
	 * extension (e.g. pi-gateway-discovery): workers run with `--no-extensions`, so such
	 * providers would otherwise be unresolvable and the spawn would fail with "Model not found".
	 */
	workerExtensions: string[];
	/**
	 * Resume the agent automatically after a compaction that fired mid-run (a `turn_end` with
	 * pending tool work). A `turn_end` that is also the run's terminal turn never auto-resumes —
	 * it stops as if nothing happened. Default true.
	 */
	resumeAfterMidRunCompaction: boolean;
	/** Power-user setting: disable all triggers (distinct from the on/off gate). */
	passive: boolean;
	/** Emit the NDJSON debug log. */
	debugLog: boolean;
	/**
	 * Hard wall-clock cap on one worker subprocess. On expiry the run is killed (SIGTERM then
	 * SIGKILL), the failure is recorded, and the worker's slot / consolidator flag are freed so a
	 * wedged worker can never permanently block the pipeline. `0` disables the hard cap.
	 */
	workerTimeoutMs: number;
	/**
	 * No-output cap on one worker subprocess: killed if it writes nothing to stdout/stderr for
	 * this long (catches a stalled provider / hung fetch that never produced a byte). A model
	 * spinning in a tool loop still emits output, so it is bounded by `workerTimeoutMs`, not this.
	 * Default 0 — **disabled**, because an idle cap has false-killed genuinely slow runs behind a
	 * loaded provider; opt in to it per setup. `0` disables the idle cap.
	 */
	workerIdleTimeoutMs: number;
	/**
	 * Worker repetition (doom) guard: when enabled, the worker extension aborts its own turn if the
	 * model collapses into an intra-message token loop ("duct duct…") or a runaway-length turn. See
	 * src/spawn/doom.ts for the detector. Default true.
	 */
	workerDoomGuard: boolean;
	/** Whole repetitions of a short period required before the guard fires (conservative: high). */
	workerDoomMinRepeats: number;
	/** Trailing window (chars) that must be tiled by the period to count as a loop. */
	workerDoomMinChars: number;
	/** Largest candidate period length the guard considers. */
	workerDoomMaxPeriod: number;
	/** Hard cap on a single assistant turn's streamed chars; beyond it the guard aborts. */
	workerDoomMaxTurnChars: number;
	/**
	 * Progress-idle cap: killed if the worker records NO activity (no streaming delta, no tool call,
	 * no turn boundary) for this long — measured from the worker's own heartbeat file, not stdout
	 * (a headless `pi -p` run buffers all output to exit, so bytes are not a liveness signal). An
	 * actively doom-looping worker keeps heartbeating, so it is bounded by the doom guard, not this.
	 * Default 300000 (5 min); `0` disables the progress cap.
	 */
	workerProgressIdleTimeoutMs: number;
	/**
	 * Extra attempts after a failed/timed-out/doomed worker, re-spawned within the same dispatch
	 * before it counts as a single failure to the circuit breaker. Default 0 (opt-in — each retry
	 * burns additional cost).
	 */
	workerRetries: number;
	/** Base delay between worker retry attempts (linear backoff: attempt N waits N× this). */
	workerRetryBackoffMs: number;
	/**
	 * Consecutive failed auto-consolidations that open the consolidator circuit breaker. Once open,
	 * the auto-trigger stops dispatching new consolidators (so a broken batch that fails every tick
	 * can no longer hot-loop forever burning cost), and `/om:status` surfaces it. A successful
	 * consolidation or a manual `/om:consolidate` resets it. `0` disables the breaker (re-dispatch
	 * freely on every tick — the pre-breaker behavior).
	 */
	consolidatorMaxConsecutiveFailures: number;
	/**
	 * Minimum interval between auto-consolidation *retries* after a failure, so a consolidator that
	 * keeps failing does not hammer the pool clock between breaker openings. `0` disables the cooldown.
	 */
	consolidatorRetryCooldownMs: number;
}

export const DEFAULTS: Config = {
	chunkTokens: 10_000,
	chunkOverlapTokens: 0,
	poolTargetTokens: 10_000,
	consolidateAtPoolTokens: 15_000,
	compactAtContextTokens: 150_000,
	tailTokens: 20_000,
	journeyTargetTokens: 1_000,
	observerConcurrency: 4,
	resumeAfterMidRunCompaction: true,
	workerExtensions: [],
	models: {
		observer: { model: "openrouter/z-ai/glm-5.3", thinking: "low" },
		consolidator: { model: "openrouter/z-ai/glm-5.3", thinking: "medium" },
	},
	passive: false,
	debugLog: false,
	workerTimeoutMs: 20 * 60 * 1000,
	workerIdleTimeoutMs: 0,
	workerDoomGuard: true,
	workerDoomMinRepeats: 32,
	workerDoomMinChars: 320,
	workerDoomMaxPeriod: 32,
	workerDoomMaxTurnChars: 40_000,
	workerProgressIdleTimeoutMs: 5 * 60 * 1000,
	workerRetries: 0,
	workerRetryBackoffMs: 2_000,
	consolidatorMaxConsecutiveFailures: 3,
	consolidatorRetryCooldownMs: 120 * 1000,
};

const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OM_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

/** Like positiveIntegerOrUndefined but accepts 0 (used for the worker watchdog caps, 0 = disabled). */
function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Expand a leading `~` to the home dir so settings can use `~/...` extension paths. */
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function normalizeModel(value: unknown, fallback: ConfiguredModel): ConfiguredModel {
	if (!isRecord(value)) return fallback;
	const model: ConfiguredModel = { model: "" };
	const full = nonEmptyString(value.model);
	if (full) {
		// Full model name, verbatim — pi's --model takes it as-is.
		model.model = full;
	} else {
		// Legacy { provider, id } shape: concatenated into a full model name.
		const provider = nonEmptyString(value.provider) ?? fallback.provider;
		const id = nonEmptyString(value.id) ?? fallback.id;
		model.model = `${provider}/${id}`;
		model.provider = provider;
		model.id = id;
	}
	const thinking = isThinkingLevel(value.thinking) ? value.thinking : fallback.thinking;
	if (thinking) model.thinking = thinking;
	return model;
}

export function normalizeSettingsConfig(value: Record<string, unknown>, base: Config): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"chunkTokens",
		"chunkOverlapTokens",
		"poolTargetTokens",
		"consolidateAtPoolTokens",
		"compactAtContextTokens",
		"tailTokens",
		"journeyTargetTokens",
		"observerConcurrency",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// chunkOverlapTokens may legitimately be 0.
	if (value.chunkOverlapTokens === 0) normalized.chunkOverlapTokens = 0;
	if (typeof value.resumeAfterMidRunCompaction === "boolean")
		normalized.resumeAfterMidRunCompaction = value.resumeAfterMidRunCompaction;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	// Worker watchdog caps: 0 is a valid value meaning "disabled", so accept any non-negative int.
	const workerTimeoutMs = nonNegativeIntegerOrUndefined(value.workerTimeoutMs);
	if (workerTimeoutMs !== undefined) normalized.workerTimeoutMs = workerTimeoutMs;
	const workerIdleTimeoutMs = nonNegativeIntegerOrUndefined(value.workerIdleTimeoutMs);
	if (workerIdleTimeoutMs !== undefined) normalized.workerIdleTimeoutMs = workerIdleTimeoutMs;
	if (typeof value.workerDoomGuard === "boolean") normalized.workerDoomGuard = value.workerDoomGuard;
	for (const key of ["workerDoomMinRepeats", "workerDoomMinChars", "workerDoomMaxPeriod", "workerDoomMaxTurnChars"] as const) {
		const v = positiveIntegerOrUndefined(value[key]);
		if (v !== undefined) normalized[key] = v;
	}
	const workerProgressIdleTimeoutMs = nonNegativeIntegerOrUndefined(value.workerProgressIdleTimeoutMs);
	if (workerProgressIdleTimeoutMs !== undefined) normalized.workerProgressIdleTimeoutMs = workerProgressIdleTimeoutMs;
	const workerRetries = nonNegativeIntegerOrUndefined(value.workerRetries);
	if (workerRetries !== undefined) normalized.workerRetries = workerRetries;
	const workerRetryBackoffMs = nonNegativeIntegerOrUndefined(value.workerRetryBackoffMs);
	if (workerRetryBackoffMs !== undefined) normalized.workerRetryBackoffMs = workerRetryBackoffMs;
	const consolidatorMaxConsecutiveFailures = nonNegativeIntegerOrUndefined(value.consolidatorMaxConsecutiveFailures);
	if (consolidatorMaxConsecutiveFailures !== undefined) normalized.consolidatorMaxConsecutiveFailures = consolidatorMaxConsecutiveFailures;
	const consolidatorRetryCooldownMs = nonNegativeIntegerOrUndefined(value.consolidatorRetryCooldownMs);
	if (consolidatorRetryCooldownMs !== undefined) normalized.consolidatorRetryCooldownMs = consolidatorRetryCooldownMs;
	if (Array.isArray(value.workerExtensions)) {
		normalized.workerExtensions = value.workerExtensions
			.filter((p): p is string => typeof p === "string" && p.length > 0)
			.map(expandHome);
	}
	if (isRecord(value.models)) {
		normalized.models = {
			observer: normalizeModel(value.models.observer, base.models.observer),
			consolidator: normalizeModel(value.models.consolidator, base.models.consolidator),
		};
	}
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string, base: Config): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested, base) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath, DEFAULTS);
	const projectConfig = readNamespacedConfig(projectPath, DEFAULTS);
	const envConfig = readEnvConfig(env);
	return {
		...DEFAULTS,
		...globalConfig,
		...projectConfig,
		...envConfig,
		models: {
			...DEFAULTS.models,
			...globalConfig.models,
			...projectConfig.models,
		},
	};
}
