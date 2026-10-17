// The face's logic, no Piu: the corner strings, the layout numbers and the
// model the phone's dicts are applied to.

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

const text = (v) => (typeof v === "string" ? v : "");
const count = (v) => (typeof v === "number" && v >= 0 ? v : null);

export function createFaceModel() {
	const m = {
		sheet: null,
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
