// App-shell service worker. Navigations: network first, cached shell offline.
// Hashed assets (/assets/*, which includes the fonts): cache first, since their
// URL changes with their content. Everything else (icons, the manifest, the
// published theme): network first, cached copy offline, so a changed file
// reaches installed clients. The hub API is never cached.
// Bumping CACHE drops every older cache on activation.
const CACHE = "pi-web-v2";
const SHELL = ["/", "/manifest.webmanifest", "/theme-init.js", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					// Never let an error page (a 502 from a proxy, say) replace the cached shell.
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put("/", copy));
					}
					return res;
				})
				.catch(() => caches.match("/")),
		);
		return;
	}
	const fromNetwork = () =>
		fetch(req).then((res) => {
			if (res.ok) {
				const copy = res.clone();
				caches.open(CACHE).then((c) => c.put(req, copy));
			}
			return res;
		});
	if (url.pathname.startsWith("/assets/")) {
		event.respondWith(caches.match(req).then((hit) => hit || fromNetwork()));
		return;
	}
	event.respondWith(fromNetwork().catch(() => caches.match(req).then((hit) => hit || Response.error())));
});

// Push (spec §5.5). The payload is { sessionId, title, kind } and optionally a short body line and a tag (same tag = replaces the earlier notification).
const PUSH_BODY = { finished: "Finished.", needs_you: "Needs you.", error: "Stopped with an error.", query: "Question waiting" };

self.addEventListener("push", (event) => {
	let p = {};
	try {
		p = (event.data && event.data.json()) || {};
	} catch {}
	const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
	const title = typeof p.title === "string" && p.title ? p.title : "pi";
	const stock = typeof p.kind === "string" && Object.hasOwn(PUSH_BODY, p.kind) ? PUSH_BODY[p.kind] : "Something happened.";
	const body = typeof p.body === "string" && p.body ? p.body : stock;
	event.waitUntil(self.registration.showNotification(title, { body, tag: (typeof p.tag === "string" && p.tag) || sessionId || "pi-web", renotify: true, data: { sessionId }, icon: "/icons/icon-192.png" }));
});

// A tap opens the session: an open window is told where to go (and focused), else a new one opens there.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const sessionId = (event.notification.data && event.notification.data.sessionId) || "";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
			const win = wins[0];
			if (!win) return self.clients.openWindow(sessionId ? `/#/s/${encodeURIComponent(sessionId)}` : "/");
			if (sessionId) win.postMessage({ type: "pi-open", sessionId });
			return win.focus();
		}),
	);
});
