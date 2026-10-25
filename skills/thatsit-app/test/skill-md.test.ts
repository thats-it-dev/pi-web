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
	const used = [...md.matchAll(/scripts\/thatsit-app\.ts (\S+)/g)].map((x) => x[1].replace(/`$/, "")).filter((c) => !c.startsWith("<"));
	assert.ok(used.length >= 4, "expected check, new, ship and pr commands");
	for (const c of used) assert.ok(known.has(c), `SKILL.md runs unknown subcommand "${c}"`);
	for (const c of known) assert.ok(used.includes(c), `SKILL.md never runs "${c}"`);
});

test("SKILL.md has the spark gateway flow", () => {
	assert.ok(m);
	const sec = m[2].match(/^## Needs spark data\n([\s\S]*?)(?=^## )/m)?.[1];
	assert.ok(sec, "section missing");
	for (const s of ["gateway-pr", "--gateway-pr", '"gateway": true', "tk-tailnet-only", "gateway-register", "gateway-checkout", "page.route"]) {
		assert.ok(sec.includes(s), `section does not name ${s}`);
	}
	assert.match(sec, /[Nn]ever merge/);
	assert.match(sec, /never edit .*`src\/`/i);
	assert.match(sec, /~\/\.local\/share\/spark-gateway/);
});

test("Change says to branch before editing", () => {
	assert.ok(m);
	const sec = m[2].match(/^## Change an existing app\n([\s\S]*?)(?=^## )/m)?.[1];
	assert.ok(sec?.includes("Create the branch (step 2) before editing any file."));
});
