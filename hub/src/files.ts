// File and folder search under a session's working directory, for @ mentions
// in the composer. Names only, never contents, always relative to the cwd.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface FileEntry {
	path: string; // relative to the cwd, no trailing slash
	dir: boolean;
}

const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(["node_modules"]);

// git knows what's ignored; outside a repo, walk the folder ourselves.
export async function listFiles(cwd: string): Promise<FileEntry[]> {
	const files = (await gitFiles(cwd)) ?? (await walk(cwd));
	return withFolders(files.slice(0, MAX_ENTRIES));
}

function gitFiles(cwd: string): Promise<string[] | null> {
	return new Promise((resolve) => {
		execFile("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
			resolve(err ? null : stdout.split("\0").filter(Boolean));
		});
	});
}

async function walk(cwd: string): Promise<string[]> {
	const out: string[] = [];
	const queue: [string, number][] = [["", 0]];
	while (queue.length && out.length < MAX_ENTRIES) {
		const [rel, depth] = queue.shift()!;
		let entries;
		try {
			entries = await readdir(join(cwd, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") && e.isDirectory()) continue;
			const path = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) queue.push([path, depth + 1]);
			} else out.push(path);
		}
	}
	return out;
}

function withFolders(files: string[]): FileEntry[] {
	const dirs = new Set<string>();
	for (const f of files) for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
	return [...[...dirs].map((path) => ({ path, dir: true })), ...files.map((path) => ({ path, dir: false }))];
}

function score(e: FileEntry, q: string): number {
	const path = e.path.toLowerCase();
	if (!q) return 1;
	if (q.endsWith("/") && path.startsWith(q) && !path.slice(q.length).includes("/")) return 5;
	const base = path.slice(path.lastIndexOf("/") + 1);
	if (base.startsWith(q)) return 4;
	if (base.includes(q)) return 3;
	if (path.includes(q)) return 2;
	let i = 0;
	for (const ch of path) if (ch === q[i]) i++;
	return i === q.length ? 1 : 0;
}

const depth = (p: string) => p.split("/").length;

export function rankFiles(entries: FileEntry[], query: string, limit: number): FileEntry[] {
	const q = query.toLowerCase();
	return entries
		.map((e) => ({ e, s: score(e, q) }))
		.filter((x) => x.s > 0)
		.sort((a, b) => {
			if (b.s !== a.s) return b.s - a.s;
			if (!q) return depth(a.e.path) - depth(b.e.path) || Number(b.e.dir) - Number(a.e.dir) || a.e.path.localeCompare(b.e.path);
			return a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path);
		})
		.slice(0, limit)
		.map((x) => x.e);
}

// Typing fires a search per keystroke, so a folder's listing is reused briefly.
export class FileLister {
	private cache = new Map<string, { at: number; entries: Promise<FileEntry[]> }>();
	private ttlMs: number;
	private now: () => number;
	private list: (cwd: string) => Promise<FileEntry[]>;

	constructor(o: { ttlMs?: number; now?: () => number; list?: (cwd: string) => Promise<FileEntry[]> } = {}) {
		this.ttlMs = o.ttlMs ?? 10_000;
		this.now = o.now ?? Date.now;
		this.list = o.list ?? listFiles;
	}

	async search(cwd: string, query: string, limit: number): Promise<FileEntry[]> {
		const now = this.now();
		for (const [k, v] of this.cache) if (now - v.at > this.ttlMs) this.cache.delete(k);
		let hit = this.cache.get(cwd);
		if (!hit) {
			hit = { at: now, entries: this.list(cwd) };
			this.cache.set(cwd, hit);
			hit.entries.catch(() => this.cache.delete(cwd));
		}
		return rankFiles(await hit.entries, query, limit);
	}
}
