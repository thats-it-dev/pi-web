import { createServer, type ServerResponse } from "node:http";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export interface StaticServer {
	port: number;
	close(): Promise<void>;
}

export const MIME: Record<string, string> = {
	html: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	woff2: "font/woff2",
	wasm: "application/wasm",
};

export const RELOAD_SCRIPT = `<script>(function(){var v=null;setInterval(function(){fetch("/__preview/version",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(v===null)v=j.version;else if(j.version!==v)location.reload()}).catch(function(){})},1000)})()</script>`;

async function maxMtime(dir: string): Promise<number> {
	let max = 0;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name.startsWith(".")) continue;
			max = Math.max(max, await maxMtime(p));
		} else {
			try {
				max = Math.max(max, (await stat(p)).mtimeMs);
			} catch {
				// vanished mid-walk
			}
		}
	}
	return max;
}

function notFound(res: ServerResponse): void {
	if (!res.headersSent) res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("Not found");
}

/** True when `file` is `base` or inside it. */
function within(base: string, file: string): boolean {
	return file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function startStaticServer(root: string): Promise<StaticServer> {
	const base = resolve(root);
	let realBase: Promise<string> | undefined;
	const server = createServer(async (req, res) => {
		try {
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			if (pathname === "/__preview/version") {
				res.writeHead(200, { "content-type": MIME.json, "cache-control": "no-store" });
				res.end(JSON.stringify({ version: await maxMtime(base) }));
				return;
			}
			const decoded = decodeURIComponent(pathname);
			// No dotfiles or dot folders (.git, .env, ..): mockups never need them.
			if (decoded.split("/").some((seg) => seg.startsWith("."))) return notFound(res);
			let file = resolve(base, `.${decoded}`);
			if (!within(base, file)) return notFound(res);
			// Clean URLs as Cloudflare Pages serves them: /resume is resume.html when no such file or folder exists
			// (website 2026-11-24: the preview 404ed on /resume, the fix linked /resume.html, and Pages redirected
			// that back to /resume; three commits and two reviews for one URL).
			let st = await stat(file).catch(() => undefined);
			if (!st && !extname(file) && !decoded.endsWith("/")) {
				file = `${file}.html`;
				st = await stat(file).catch(() => undefined);
			}
			if (!st) return notFound(res);
			if (st.isDirectory()) {
				file = join(file, "index.html");
				st = await stat(file);
			}
			if (!st.isFile()) return notFound(res);
			// A symlink inside the root must not reach a file outside it.
			realBase ??= realpath(base);
			if (!within(await realBase, await realpath(file))) return notFound(res);
			const ext = extname(file).slice(1).toLowerCase();
			const type = MIME[ext] ?? "application/octet-stream";
			let body: Buffer | string = await readFile(file);
			if (ext === "html") {
				const html = body.toString("utf8");
				const i = html.lastIndexOf("</body>");
				body = i >= 0 ? html.slice(0, i) + RELOAD_SCRIPT + html.slice(i) : html + RELOAD_SCRIPT;
			}
			res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
			res.end(body);
		} catch {
			notFound(res);
		}
	});
	return new Promise((ok, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") return fail(new Error("no port"));
			ok({
				port: addr.port,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						server.closeAllConnections();
					}),
			});
		});
	});
}
