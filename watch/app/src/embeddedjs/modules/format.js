export function clipTo(s, n) {
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function toolbar(stats) {
	const s = stats || {};
	const percent = typeof s.ctxPercent === "number" ? s.ctxPercent : null;
	return {
		ctx: percent === null ? "--" : percent + "%",
		percent,
		speed: typeof s.tps === "number" ? s.tps + " T/S" : "--",
		model: s.model ? s.model.toUpperCase() : "",
	};
}

export function statusLeft(home, net) {
	if (net === "connecting") return "CONNECTING";
	if (net === "offline") return "OFFLINE";
	if (net === "unconfigured") return "NO HUB URL";
	return "PI-WEB " + (home ? home.index : 0) + "/" + (home ? home.count : 0);
}

export function clock(date, h24) {
	const m = String(date.getMinutes()).padStart(2, "0");
	const h = date.getHours();
	if (h24) return String(h).padStart(2, "0") + ":" + m;
	return (h % 12 || 12) + ":" + m;
}

export function queryText(home) {
	if (!home) return "";
	// Spec §7.2: a dialog reads `<tool>: <title>`; a finished turn or an error is just its text.
	const plain = home.kind === "finished" || home.kind === "error";
	return home.tool && !plain ? home.tool + ": " + home.text : home.text;
}

export function hint(home, stats) {
	const title = clipTo((home && home.sessionTitle) || "", 20);
	return (title + " · " + ((stats && stats.state) || "")).toUpperCase();
}

export function sessionMeta(row) {
	if (!row.live) return "CLOSED · " + row.age;
	const parts = [String(row.state).toUpperCase()];
	if (row.model) parts.push(row.model.toUpperCase());
	if (row.ctx !== null && row.ctx !== undefined) parts.push(row.ctx + "%");
	return parts.join(" · ");
}

export function menuMeta(stats) {
	const s = stats || {};
	const line1 = ((s.model || "") + " · " + (s.state || "")).toUpperCase();
	const k = (n) => Math.round(n / 1000) + "k";
	const line2 = typeof s.ctxTokens === "number" && typeof s.ctxWindow === "number" ? k(s.ctxTokens) + " of " + k(s.ctxWindow) : "";
	return [line1, line2];
}
