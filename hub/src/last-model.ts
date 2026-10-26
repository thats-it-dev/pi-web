// The model and thinking level most recently picked in any pi-web session, so
// a new session can start on it. One small file in the data dir.

import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "../../shared/src/protocol.ts";
import { writeAtomic } from "./push.ts";

export interface ModelChoice {
	provider: string;
	modelId: string;
	thinking: ThinkingLevel | null;
}

export class LastModelStore {
	private file: string;

	constructor(file: string) {
		this.file = file;
	}

	get(): ModelChoice | null {
		try {
			const c = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ModelChoice>;
			if (typeof c.provider !== "string" || typeof c.modelId !== "string") return null;
			return { provider: c.provider, modelId: c.modelId, thinking: typeof c.thinking === "string" ? c.thinking : null };
		} catch {
			return null;
		}
	}

	set(c: ModelChoice): void {
		writeAtomic(this.file, JSON.stringify(c));
	}
}
