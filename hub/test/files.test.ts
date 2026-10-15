import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type FileEntry, FileLister, listFiles, rankFiles } from "../src/files.ts";

function tree(files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-files-"));
	for (const f of files) {
		mkdirSync(join(dir, f, ".."), { recursive: true });
		writeFileSync(join(dir, f), "");
	}
	return dir;
}

const paths = (es: FileEntry[]) => es.map((e) => (e.dir ? `${e.path}/` : e.path));

test("in a git repo, lists tracked and untracked files plus their folders, minus ignored ones", async () => {
	const dir = tree([".gitignore", "src/a.ts", "src/lib/b.ts", "dist/out.js", "notes.md"]);
	writeFileSync(join(dir, ".gitignore"), "dist/\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "src"], { cwd: dir });
	const got = paths(await listFiles(dir)).sort();
	assert.deepEqual(got, [".gitignore", "notes.md", "src/", "src/a.ts", "src/lib/", "src/lib/b.ts"]);
});

test("in a git subfolder, paths are relative to that folder", async () => {
	const dir = tree(["top.md", "pkg/src/x.ts"]);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	assert.deepEqual(paths(await listFiles(join(dir, "pkg"))).sort(), ["src/", "src/x.ts"]);
});

test("outside git, walks the folder and skips dot folders and node_modules", async () => {
	const dir = tree(["a.txt", "deep/b.txt", ".hidden/c.txt", "node_modules/m/index.js"]);
	assert.deepEqual(paths(await listFiles(dir)).sort(), ["a.txt", "deep/", "deep/b.txt"]);
});

const ENTRIES: FileEntry[] = [
	{ path: "README.md", dir: false },
	{ path: "src", dir: true },
	{ path: "src/components", dir: true },
	{ path: "src/components/pi-composer.ts", dir: false },
	{ path: "src/lib", dir: true },
	{ path: "src/lib/mention.ts", dir: false },
	{ path: "src/lib/composer-utils.ts", dir: false },
];

test("an empty query shows the top level first", () => {
	assert.deepEqual(paths(rankFiles(ENTRIES, "", 2)), ["src/", "README.md"]);
});

test("basename prefix beats substring beats path subsequence", () => {
	assert.deepEqual(paths(rankFiles(ENTRIES, "comp", 10)), ["src/components/", "src/lib/composer-utils.ts", "src/components/pi-composer.ts"]);
	assert.deepEqual(paths(rankFiles(ENTRIES, "slmen", 10)), ["src/lib/mention.ts"]);
	assert.deepEqual(rankFiles(ENTRIES, "zzz", 10), []);
});

test("a query ending in / lists that folder's children first", () => {
	assert.deepEqual(paths(rankFiles(ENTRIES, "src/lib/", 2)), ["src/lib/mention.ts", "src/lib/composer-utils.ts"]);
});

test("the lister caches a folder's listing briefly", async () => {
	let calls = 0;
	let now = 0;
	const lister = new FileLister({ ttlMs: 1000, now: () => now, list: async () => (calls++, ENTRIES) });
	await lister.search("/w", "a", 5);
	await lister.search("/w", "b", 5);
	assert.equal(calls, 1);
	now = 2000;
	await lister.search("/w", "a", 5);
	assert.equal(calls, 2);
});
