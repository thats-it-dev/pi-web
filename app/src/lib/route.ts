export type Route = { name: "home" } | { name: "session"; id: string } | { name: "new" } | { name: "settings" };

export function parseRoute(hash: string): Route {
	const [path] = hash.replace(/^#\/?/, "").split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts[0] === "s" && parts[1]) return { name: "session", id: decodeURIComponent(parts[1]) };
	if (parts[0] === "new") return { name: "new" };
	if (parts[0] === "settings") return { name: "settings" };
	return { name: "home" };
}

export function hrefFor(r: Route): string {
	switch (r.name) {
		case "home":
			return "#/";
		case "session":
			return `#/s/${encodeURIComponent(r.id)}`;
		case "new":
			return "#/new";
		case "settings":
			return "#/settings";
	}
}
