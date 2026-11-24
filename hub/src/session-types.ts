// Which sessions are chat sessions. Everything not recorded here is code, so
// the file only ever holds chat ids: { "<sessionId>": "chat" }.

import { readFileSync } from "node:fs";
import type { SessionType } from "../../shared/src/protocol.ts";
import { writeAtomic } from "./push.ts";

export class SessionTypeStore {
	private file: string;
	private map: Record<string, SessionType> | null = null;

	constructor(file: string) {
		this.file = file;
	}

	private load(): Record<string, SessionType> {
		if (this.map) return this.map;
		const map: Record<string, SessionType> = {};
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				for (const [id, t] of Object.entries(raw)) if (t === "chat") map[id] = "chat";
			}
		} catch {}
		return (this.map = map);
	}

	get(id: string): SessionType {
		return Object.hasOwn(this.load(), id) ? "chat" : "code";
	}

	set(id: string, type: SessionType): void {
		const map = this.load();
		if (type === "chat") map[id] = "chat";
		else delete map[id];
		writeAtomic(this.file, JSON.stringify(map));
	}
}
