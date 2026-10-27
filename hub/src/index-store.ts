// Where Index 01 deliveries are kept: <dataDir>/index/<delivery>.m4a (when there
// was audio) and <delivery>.json (always). Only the newest `keep` survive.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexHeaders } from "./index-webhook.ts";

export interface Sidecar {
	receivedAt: number;
	headers: IndexHeaders;
	transcription: string;
	recordedAt?: string;
	client?: string;
	action: "answered" | "no_match" | "prompted" | "new_session" | "kept_audio" | "error";
	sessionId?: string;
	queryId?: string;
	reason?: string;
}

export function storeName(delivery: string): string {
	return delivery.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export function indexDir(dataDir: string): string {
	const dir = join(dataDir, "index");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function saveAudio(dataDir: string, delivery: string, audio: Buffer): void {
	writeFileSync(join(indexDir(dataDir), `${storeName(delivery)}.m4a`), audio);
}

export function saveSidecar(dataDir: string, delivery: string, sidecar: Sidecar): void {
	writeFileSync(join(indexDir(dataDir), `${storeName(delivery)}.json`), JSON.stringify(sidecar, null, 2));
}

export function prune(dataDir: string, keep: number): void {
	const dir = indexDir(dataDir);
	const jsons = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
		.sort((a, b) => b.at - a.at);
	for (const { f } of jsons.slice(keep)) {
		rmSync(join(dir, f), { force: true });
		rmSync(join(dir, `${f.slice(0, -".json".length)}.m4a`), { force: true });
	}
}
