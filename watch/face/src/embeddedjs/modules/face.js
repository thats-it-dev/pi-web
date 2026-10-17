// The face's logic, no Piu: the corner strings, the layout numbers, the sheet's
// texts and the model the phone's dicts are applied to.
import { wrapLines } from "format";

// Same order as package.json pebble.messageKeys: pebble/message maps index n to key 10000 + n.
export const KEYS = (
	"MSG CMD CMD_ID REQ_ID REQ_KIND REQ_TOOL REQ_TEXT REQ_INDEX REQ_COUNT VIBE " +
	"PI_RUNNING PI_PENDING TEMP NET OK DARK CORNER_TL CORNER_TR CORNER_BL CORNER_BR UNIT HUB_URL"
).split(" ");

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WIDGETS = ["date", "pi", "hr", "steps", "battery", "weather", "none"];
export const CORNERS = ["CORNER_TL", "CORNER_TR", "CORNER_BL", "CORNER_BR"];
const DEFAULTS = ["date", "pi", "hr", "steps"];

export function dateLabel(date) {
	return DAYS[date.getDay()] + " " + date.getDate();
}

const positive = (n) => (typeof n === "number" && n > 0 ? String(n) : "--");

// data: { date, pi: { running, pending }, hr, steps, battery, temp }.
export function cornerText(id, data) {
	switch (id) {
		case "date":
			return data.date ? dateLabel(data.date) : "--";
		case "pi":
			return data.pi ? data.pi.running + "/" + data.pi.pending : "--";
		case "hr":
			return positive(data.hr);
		case "steps":
			return positive(data.steps);
		case "battery":
			return typeof data.battery === "number" && data.battery >= 0 ? data.battery + "%" : "--";
		case "weather":
			return data.temp || "--";
	}
	return "";
}

// Positions for a group w x h: the time centred, the corners inset (on round, clear of the rim).
export function layout(w, h, round) {
	return {
		time: { top: Math.round(h / 2) - 24, height: 48 },
		corners: { inset: round ? Math.round(w * 0.25) : 8, top: round ? Math.round(h * 0.17) : 6, height: 22 },
	};
}

// The sheet (spec §6.2): its height, the rise, and the message's line scroll.
export const SHEET_HEIGHT = 84;
export const RISE_MS = 350;
export const SCROLL_PAUSE_MS = 2000;
export const SCROLL_STEP_MS = 1500;

// sheet: { kind, tool, text, index, count } as the model holds it.
export function sheetText(sheet) {
	const name = sheet.kind === "finished" ? "DONE" : sheet.kind === "error" ? "ERROR" : sheet.tool ? sheet.tool.toUpperCase() : "QUESTION";
	const counter = sheet.index + " OF " + sheet.count;
	return {
		eyebrow: "PI-WEB · " + name,
		lines: (width, measure) => wrapLines(sheet.text, width, measure),
		footer: (opening) => [opening ? "opening…" : "FLICK TO OPEN", counter],
	};
}

// The line scroll for a message `max` lines longer than its clip: from offset k
// (-1 to start), [the next offset, how long it stays there]. It pauses at the
// top, steps a line at a time, pauses at the end, then jumps back to the top.
export function scrollNext(k, max) {
	if (k < 0) return [0, SCROLL_PAUSE_MS];
	if (k >= max) return [0, SCROLL_PAUSE_MS];
	return [k + 1, k + 1 < max ? SCROLL_STEP_MS : SCROLL_PAUSE_MS];
}

const text = (v) => (typeof v === "string" ? v : "");
const count = (v) => (typeof v === "number" && v >= 0 ? v : null);

export function createFaceModel() {
	const m = {
		sheet: null,
		// Set by a sheet dict with VIBE 1; the face clears it when it has vibed.
		vibe: false,
		pi: null,
		temp: null,
		net: "connecting",
		cfg: { dark: true, corners: DEFAULTS.slice(), unit: "C" },
		// Applies one dict; returns its kind, or null when it is not one the face knows.
		apply(map) {
			const msg = map.get("MSG");
			if (msg === "sheet") {
				const id = text(map.get("REQ_ID"));
				m.sheet = id
					? { id, kind: text(map.get("REQ_KIND")), tool: text(map.get("REQ_TOOL")), text: text(map.get("REQ_TEXT")), index: count(map.get("REQ_INDEX")) || 0, count: count(map.get("REQ_COUNT")) || 0 }
					: null;
				if (map.get("VIBE") === 1) m.vibe = true;
			} else if (msg === "pi") {
				const running = count(map.get("PI_RUNNING"));
				const pending = count(map.get("PI_PENDING"));
				m.pi = running === null || pending === null ? null : { running, pending };
			} else if (msg === "weather") {
				m.temp = text(map.get("TEMP")) || null;
			} else if (msg === "net") {
				m.net = text(map.get("NET")) || m.net;
			} else if (msg === "cfg") {
				const cfg = m.cfg;
				if (map.has("DARK")) cfg.dark = map.get("DARK") !== 0;
				CORNERS.forEach((k, i) => {
					if (!map.has(k)) return;
					const id = map.get(k);
					cfg.corners[i] = WIDGETS.includes(id) ? id : DEFAULTS[i];
				});
				const unit = map.get("UNIT");
				if (unit === "C" || unit === "F") cfg.unit = unit;
			} else return null;
			return msg;
		},
	};
	return m;
}
