// The models pi offers, pi's own default, and each reasoning model's thinking
// levels, so the app can show them before any session exists. Learned from a
// short-lived `pi --mode rpc --no-session` and cached for a while.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { ModelInfo, SessionStateInfo, ThinkingLevel } from "../../shared/src/protocol.ts";
import { lineSplitter } from "../../shared/src/jsonl.ts";
import type { ModelChoice } from "./last-model.ts";
import { slimModel } from "./rpc-handle.ts";
import type { RpcCommand } from "./translate.ts";

const PROBE_TIMEOUT_MS = 30_000;

export interface Catalog {
	models: ModelInfo[];
	piDefault: ModelChoice | null;
	levels: Record<string, ThinkingLevel[]>; // keyed `provider/id`
}

const EMPTY: Catalog = { models: [], piDefault: null, levels: {} };

export const modelKey = (provider: string, id: string) => `${provider}/${id}`;

export class ModelCatalog {
	private opts: { piBin: string; env?: Record<string, string>; ttlMs?: number };
	private cached: { at: number; cat: Catalog } | null = null;
	private inFlight: Promise<Catalog> | null = null;

	constructor(opts: { piBin: string; env?: Record<string, string>; ttlMs?: number }) {
		this.opts = opts;
	}

	get(): Promise<Catalog> {
		if (this.cached && Date.now() - this.cached.at < (this.opts.ttlMs ?? 10 * 60_000)) return Promise.resolve(this.cached.cat);
		this.inFlight ??= probe(this.opts.piBin, this.opts.env)
			.then((cat) => {
				this.cached = { at: Date.now(), cat };
				return cat;
			})
			.catch(() => EMPTY)
			.finally(() => {
				this.inFlight = null;
			});
		return this.inFlight;
	}
}

// `wanted` if pi still offers that model (keeping its thinking level only when
// the model has it), else pi's own default.
export function resolveChoice(cat: Catalog, wanted: ModelChoice | null): ModelChoice | null {
	if (!wanted || !cat.models.some((m) => m.provider === wanted.provider && m.id === wanted.modelId)) return cat.piDefault;
	const levels = cat.levels[modelKey(wanted.provider, wanted.modelId)] ?? [];
	return { ...wanted, thinking: wanted.thinking && levels.includes(wanted.thinking) ? wanted.thinking : null };
}

async function probe(piBin: string, env?: Record<string, string>): Promise<Catalog> {
	const proc = spawn(piBin, ["--mode", "rpc", "--no-session"], { cwd: homedir(), env: { ...process.env, ...env, PI_WEB: "1" } });
	const pending = new Map<string, (r: { success: boolean; data?: unknown; error?: string }) => void>();
	let n = 0;
	const failed = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => reject(new Error("model probe timed out")), PROBE_TIMEOUT_MS);
		timer.unref();
		proc.on("error", reject);
		proc.on("close", () => reject(new Error("pi exited during the model probe")));
	});
	let dead = false;
	failed.catch(() => {
		dead = true; // also expected after a finished probe: the kill below closes pi
	});
	proc.stdin.on("error", () => {});
	proc.stderr.resume();
	proc.stdout.setEncoding("utf8");
	proc.stdout.on(
		"data",
		lineSplitter((line) => {
			try {
				const rec = JSON.parse(line);
				if (rec.type === "response" && pending.has(rec.id)) pending.get(rec.id)?.(rec);
			} catch {}
		}),
	);
	const call = <T>(cmd: RpcCommand): Promise<T> => {
		const id = `probe-${++n}`;
		const reply = new Promise<T>((resolve, reject) => {
			pending.set(id, (r) => {
				pending.delete(id);
				if (r.success) resolve(r.data as T);
				else reject(new Error(r.error ?? `${cmd.type} failed`));
			});
		});
		proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
		return Promise.race([reply, failed]);
	};
	try {
		const [{ models }, state] = await Promise.all([call<{ models: ModelInfo[] }>({ type: "get_available_models" }), call<SessionStateInfo>({ type: "get_state" })]);
		const levels: Catalog["levels"] = {};
		for (const m of models) {
			if (!m.reasoning) {
				levels[modelKey(m.provider, m.id)] = [];
				continue;
			}
			// One at a time: each set_model changes what the next levels call reports.
			// A model pi refuses to switch to (say, no API key) just has no levels; a dead probe fails as a whole.
			const switched = await call({ type: "set_model", provider: m.provider, modelId: m.id }).then(
				() => true,
				(err) => {
					if (dead) throw err;
					return false;
				},
			);
			levels[modelKey(m.provider, m.id)] = switched ? (await call<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" })).levels : [];
		}
		return {
			models: models.map(slimModel),
			piDefault: state.model ? { provider: state.model.provider, modelId: state.model.id, thinking: state.thinkingLevel ?? null } : null,
			levels,
		};
	} finally {
		proc.kill("SIGKILL");
	}
}
