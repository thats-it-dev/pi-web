// App-shell service worker. Navigations: network first, cached shell offline.
// Hashed assets and fonts: cache first. The hub API is never cached.
const CACHE = "pi-web-v1";
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
	event.respondWith(
		caches.match(req).then(
			(hit) =>
				hit ||
				fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put(req, copy));
					}
					return res;
				}),
		),
	);
});
