import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startStaticServer } from "../static-server.ts";

const root = mkdtempSync(join(tmpdir(), "preview-static-"));
writeFileSync(join(root, "index.html"), "<html><body><h1>hi</h1></body></html>");
mkdirSync(join(root, "sub"));
writeFileSync(join(root, "sub", "index.html"), "<body>sub</body>");
writeFileSync(join(root, "a.css"), "h1{}");
after(() => rmSync(root, { recursive: true, force: true }));

test("serves index.html with the reload script, css with its type, 404 for missing and escapes", async () => {
	const s = await startStaticServer(root);
	try {
		const base = `http://127.0.0.1:${s.port}`;
		const home = await fetch(`${base}/`);
		assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
		const text = await home.text();
		assert.match(text, /<h1>hi<\/h1>/);
		assert.match(text, /__preview\/version/);
		assert.match(await (await fetch(`${base}/sub/`)).text(), /sub/);
		assert.equal((await fetch(`${base}/a.css`)).headers.get("content-type"), "text/css; charset=utf-8");
		assert.equal((await fetch(`${base}/nope.html`)).status, 404);
		assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404);
	} finally {
		await s.close();
	}
});

test("the version endpoint changes when a file changes", async () => {
	const s = await startStaticServer(root);
	try {
		const url = `http://127.0.0.1:${s.port}/__preview/version`;
		const v1 = ((await (await fetch(url)).json()) as { version: number }).version;
		const later = new Date(Date.now() + 5000);
		utimesSync(join(root, "a.css"), later, later);
		const v2 = ((await (await fetch(url)).json()) as { version: number }).version;
		assert.ok(v2 > v1);
	} finally {
		await s.close();
	}
});
