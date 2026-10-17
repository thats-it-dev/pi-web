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

// The end of a transcript in at most `max` lines of `width` px (measure(s) → px),
// as whole lines for Labels: words wrap from the end, and where text is dropped
// the first line starts with `…` (a word too long for a line keeps its end).
export function tailLines(text, width, measure, max = 2) {
	const words = String(text).trim().split(/\s+/).filter(Boolean);
	const fitTail = (s) => {
		let k = 1;
		while (k < s.length && measure("…" + s.slice(k)) > width) k++;
		return "…" + s.slice(k);
	};
	const lines = [];
	let i = words.length - 1;
	while (i >= 0 && lines.length < max) {
		if (measure(words[i]) > width) {
			lines.unshift(fitTail(words[i]));
			return lines;
		}
		let line = words[i--];
		while (i >= 0 && measure(words[i] + " " + line) <= width) line = words[i--] + " " + line;
		lines.unshift(line);
	}
	if (i >= 0) {
		let first = lines[0];
		while (measure("…" + first) > width) {
			const sp = first.indexOf(" ");
			if (sp < 0) return [fitTail(first)].concat(lines.slice(1));
			first = first.slice(sp + 1);
		}
		lines[0] = "…" + first;
	}
	return lines;
}
