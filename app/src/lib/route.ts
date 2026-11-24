export type Route = { name: "home" } | { name: "session"; id: string; at?: number } | { name: "subagent"; id: string; key: string } | { name: "new" } | { name: "settings" };

export function parseRoute(hash: string): Route {
	try {
		return parse(hash);
	} catch {
		return { name: "home" }; // a malformed %-escape
	}
}

function parse(hash: string): Route {
	const [path] = hash.replace(/^#\/?/, "").split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts[0] === "s" && parts[1] && parts[2] === "sub" && parts[3]) return { name: "subagent", id: decodeURIComponent(parts[1]), key: decodeURIComponent(parts[3]) };
	if (parts[0] === "s" && parts[1]) {
		const id = decodeURIComponent(parts[1]);
		if (parts[2] === "at" && /^\d+$/.test(parts[3] ?? "")) return { name: "session", id, at: Number(parts[3]) };
		return { name: "session", id };
	}
	if (parts[0] === "new") return { name: "new" };
	if (parts[0] === "settings") return { name: "settings" };
	return { name: "home" };
}

export function hrefFor(r: Route): string {
	switch (r.name) {
		case "home":
			return "#/";
		case "session":
			return `#/s/${encodeURIComponent(r.id)}${typeof r.at === "number" ? `/at/${r.at}` : ""}`;
		case "subagent":
			return `#/s/${encodeURIComponent(r.id)}/sub/${encodeURIComponent(r.key)}`;
		case "new":
			return "#/new";
		case "settings":
			return "#/settings";
	}
}
