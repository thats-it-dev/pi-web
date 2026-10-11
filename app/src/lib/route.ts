export type Route = { name: "home" } | { name: "session"; id: string } | { name: "new"; cwd?: string } | { name: "settings" };

export function parseRoute(hash: string): Route {
	const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts[0] === "s" && parts[1]) return { name: "session", id: decodeURIComponent(parts[1]) };
	if (parts[0] === "new") {
		const cwd = new URLSearchParams(query).get("cwd");
		return cwd ? { name: "new", cwd } : { name: "new" };
	}
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
			return r.cwd ? `#/new?${new URLSearchParams({ cwd: r.cwd })}` : "#/new";
		case "settings":
			return "#/settings";
	}
}
