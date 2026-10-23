import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const md = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const cli = readFileSync(new URL("../scripts/thatsit-app.ts", import.meta.url), "utf8");
const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

test("SKILL.md frontmatter names the skill and says when to use it", () => {
	assert.ok(m, "frontmatter missing");
	const fm = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
	assert.equal(fm.name, "thatsit-app");
	assert.match(fm.description, /^Use when /);
	assert.match(fm.description, /thatsit\.app/);
});

test("SKILL.md body stays short for local models", () => {
	assert.ok(m);
	const lines = m[2].replace(/\n$/, "").split("\n").length;
	assert.ok(lines <= 150, `body is ${lines} lines`);
});

test("every subcommand SKILL.md runs is in the CLI usage", () => {
	const usage = cli.match(/'usage: thatsit-app ([^']*)'/)?.[1];
	assert.ok(usage, "usage string not found");
	const known = new Set(usage.split("|").map((s) => s.trim().split(" ")[0]));
	const used = [...md.matchAll(/scripts\/thatsit-app\.ts (\S+)/g)].map((x) => x[1]).filter((c) => !c.startsWith("<"));
	assert.ok(used.length >= 4, "expected check, new, ship and pr commands");
	for (const c of used) assert.ok(known.has(c), `SKILL.md runs unknown subcommand "${c}"`);
	for (const c of known) assert.ok(used.includes(c), `SKILL.md never runs "${c}"`);
});
