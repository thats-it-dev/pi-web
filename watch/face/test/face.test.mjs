import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// On the watch, "format" is a manifest module name; here it resolves to the shared file.
registerHooks({
	resolve(specifier, context, next) {
		return specifier === "format" ? next(new URL("../../shared/js/format.js", import.meta.url).href, context) : next(specifier, context);
	},
});
const { cornerText, dateLabel, layout, createFaceModel, KEYS, sheetText, scrollNext, SHEET_HEIGHT, RISE_MS, SCROLL_PAUSE_MS, SCROLL_STEP_MS } = await import("../src/embeddedjs/modules/face.js");

const M = (o) => new Map(Object.entries(o));

test("KEYS match package.json messageKeys in order (pebble/message maps index n to 10000 + n)", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(KEYS, pkg.pebble.messageKeys);
});

test("dateLabel is the weekday and the day of the month", () => {
	assert.equal(dateLabel(new Date(2026, 9, 15, 9, 41)), "THU 15");
	assert.equal(dateLabel(new Date(2026, 9, 4)), "SUN 4");
});

test("cornerText formats each widget and shows -- without data", () => {
	assert.equal(cornerText("date", { date: new Date(2026, 9, 15, 9, 41) }), "THU 15");
	assert.equal(cornerText("pi", { pi: { running: 2, pending: 1 } }), "2/1");
	assert.equal(cornerText("pi", {}), "--");
	assert.equal(cornerText("hr", { hr: 72 }), "72");
	assert.equal(cornerText("hr", { hr: 0 }), "--");
	assert.equal(cornerText("steps", { steps: 4210 }), "4210");
	assert.equal(cornerText("battery", { battery: 80 }), "80%");
	assert.equal(cornerText("weather", { temp: "12°" }), "12°");
	assert.equal(cornerText("weather", {}), "--");
	assert.equal(cornerText("none", {}), "");
});

test("cornerText: missing health readings and the date show --; an unknown id draws nothing", () => {
	assert.equal(cornerText("date", {}), "--");
	assert.equal(cornerText("hr", {}), "--");
	assert.equal(cornerText("steps", {}), "--");
	assert.equal(cornerText("battery", {}), "--");
	assert.equal(cornerText("weather", { temp: "" }), "--");
	assert.equal(cornerText("bogus", { hr: 72 }), "");
});

test("layout: emery idle and sheet heights; gabbro insets", () => {
	assert.deepEqual(layout(200, 228, false), { time: { top: 90, height: 48 }, corners: { inset: 8, top: 6, height: 22 } });
	assert.deepEqual(layout(200, 144, false), { time: { top: 48, height: 48 }, corners: { inset: 8, top: 6, height: 22 } });
	assert.deepEqual(layout(260, 260, true), { time: { top: 106, height: 48 }, corners: { inset: 65, top: 44, height: 22 } });
	assert.deepEqual(layout(260, 176, true), { time: { top: 64, height: 48 }, corners: { inset: 65, top: 30, height: 22 } });
});

test("the model applies sheet, pi, weather, cfg and net dicts and reports the kind", () => {
	const m = createFaceModel();
	assert.equal(m.sheet, null);
	assert.equal(m.pi, null);
	assert.equal(m.temp, null);
	assert.equal(m.net, "connecting");
	assert.deepEqual(m.cfg, { dark: true, corners: ["date", "pi", "hr", "steps"], unit: "C" });

	const kind = m.apply(new Map([["MSG", "sheet"], ["REQ_ID", "d1"], ["REQ_KIND", "dialog"], ["REQ_TOOL", "bash"], ["REQ_TEXT", "Allow?"], ["REQ_INDEX", 1], ["REQ_COUNT", 2]]));
	assert.equal(kind, "sheet");
	assert.deepEqual(m.sheet, { id: "d1", kind: "dialog", tool: "bash", text: "Allow?", index: 1, count: 2 });
	assert.equal(m.apply(M({ MSG: "sheet", REQ_ID: "", REQ_KIND: "", REQ_TOOL: "", REQ_TEXT: "", REQ_INDEX: 0, REQ_COUNT: 0 })), "sheet");
	assert.equal(m.sheet, null);

	assert.equal(m.apply(M({ MSG: "pi", PI_RUNNING: 2, PI_PENDING: 1 })), "pi");
	assert.deepEqual(m.pi, { running: 2, pending: 1 });
	m.apply(M({ MSG: "pi", PI_RUNNING: -1, PI_PENDING: -1 }));
	assert.equal(m.pi, null);

	assert.equal(m.apply(M({ MSG: "weather", TEMP: "12°" })), "weather");
	assert.equal(m.temp, "12°");
	m.apply(M({ MSG: "weather", TEMP: "" }));
	assert.equal(m.temp, null);

	assert.equal(m.apply(M({ MSG: "cfg", DARK: 0, CORNER_TL: "battery", CORNER_TR: "weather", CORNER_BL: "none", CORNER_BR: "pi", UNIT: "F" })), "cfg");
	assert.deepEqual(m.cfg, { dark: false, corners: ["battery", "weather", "none", "pi"], unit: "F" });
	// A cfg with only DARK (the stub's /dev/settings, an older phone) keeps the corners.
	m.apply(M({ MSG: "cfg", DARK: 1 }));
	assert.deepEqual(m.cfg, { dark: true, corners: ["battery", "weather", "none", "pi"], unit: "F" });
	// An unknown widget id falls back to the default for that corner.
	m.apply(M({ MSG: "cfg", DARK: 1, CORNER_TL: "moon" }));
	assert.equal(m.cfg.corners[0], "date");

	assert.equal(m.apply(M({ MSG: "net", NET: "idle" })), "net");
	assert.equal(m.net, "idle");

	assert.equal(m.apply(M({ MSG: "bogus" })), null);
	assert.equal(m.apply(new Map()), null);
});

test("cornerText gives every widget id its string from one data object", () => {
	const data = { date: new Date(2026, 9, 15, 9, 41), pi: { running: 1, pending: 3 }, hr: 72, steps: 4210, battery: 80, temp: "12°" };
	const ids = ["date", "pi", "hr", "steps", "battery", "weather", "none"];
	assert.deepEqual(ids.map((id) => cornerText(id, data)), ["THU 15", "1/3", "72", "4210", "80%", "12°", ""]);
});

test("a cfg dict assigns the four corners and the unit; unknown ids fall back to the slot default", () => {
	const m = createFaceModel();
	assert.equal(m.apply(M({ MSG: "cfg", DARK: 0, CORNER_TL: "battery", CORNER_TR: "none", CORNER_BL: "weather", CORNER_BR: "bogus", UNIT: "F" })), "cfg");
	assert.deepEqual(m.cfg, { dark: false, corners: ["battery", "none", "weather", "steps"], unit: "F" });
});

test("the sheet's numbers (spec §6.2)", () => {
	assert.deepEqual([SHEET_HEIGHT, RISE_MS, SCROLL_PAUSE_MS, SCROLL_STEP_MS], [84, 350, 2000, 1500]);
});

test("sheetText: the eyebrow names the tool, DONE, ERROR or QUESTION", () => {
	const dialog = { kind: "dialog", tool: "bash", text: "Allow bash?\ngit push origin main", index: 1, count: 2 };
	assert.equal(sheetText(dialog).eyebrow, "PI-WEB · BASH");
	assert.equal(sheetText({ ...dialog, kind: "finished", tool: "question" }).eyebrow, "PI-WEB · DONE");
	assert.equal(sheetText({ ...dialog, kind: "error", tool: "" }).eyebrow, "PI-WEB · ERROR");
	assert.equal(sheetText({ ...dialog, tool: "" }).eyebrow, "PI-WEB · QUESTION");
});

test("sheetText: the footer is the hint and the counter", () => {
	const s = sheetText({ kind: "dialog", tool: "bash", text: "Allow bash?", index: 1, count: 2 });
	assert.deepEqual(s.footer(false), ["FLICK TO OPEN", "1 OF 2"]);
	assert.deepEqual(s.footer(true), ["opening…", "1 OF 2"]);
});

test("sheetText: lines wraps the message to the width and keeps every line, newlines honoured", () => {
	const measure = (s) => s.length * 8;
	const s = sheetText({ kind: "dialog", tool: "bash", text: "Allow bash?\ngit push origin main", index: 1, count: 2 });
	assert.deepEqual(s.lines(160, measure), ["Allow bash?", "git push origin main"]);
	const long = sheetText({ kind: "finished", tool: "", text: "Done. The bridge tests pass and the build is clean. Want me to run the emulator smoke test next?", index: 1, count: 1 });
	// 160 px is 20 characters here: all six lines come back (the sheet scrolls them).
	assert.deepEqual(long.lines(160, measure), ["Done. The bridge", "tests pass and the", "build is clean. Want", "me to run the", "emulator smoke test", "next?"]);
});

test("scrollNext: pause at the top, a line per step to the end, pause, back to the top", () => {
	// From offset k (-1 to start), with `max` lines below the clip: [next offset, how long it stays there].
	assert.deepEqual(scrollNext(-1, 3), [0, SCROLL_PAUSE_MS]);
	assert.deepEqual(scrollNext(0, 3), [1, SCROLL_STEP_MS]);
	assert.deepEqual(scrollNext(1, 3), [2, SCROLL_STEP_MS]);
	assert.deepEqual(scrollNext(2, 3), [3, SCROLL_PAUSE_MS]);
	assert.deepEqual(scrollNext(3, 3), [0, SCROLL_PAUSE_MS]);
	// A two-line clip scrolls one line: down after the pause, back after the pause.
	assert.deepEqual(scrollNext(0, 1), [1, SCROLL_PAUSE_MS]);
	assert.deepEqual(scrollNext(1, 1), [0, SCROLL_PAUSE_MS]);
});

test("a sheet dict with VIBE 1 sets the model's vibe flag; VIBE 0 leaves it", () => {
	const m = createFaceModel();
	assert.equal(m.vibe, false);
	m.apply(M({ MSG: "sheet", REQ_ID: "d1", REQ_KIND: "dialog", REQ_TOOL: "bash", REQ_TEXT: "Allow?", REQ_INDEX: 1, REQ_COUNT: 1, VIBE: 0 }));
	assert.equal(m.vibe, false);
	m.apply(M({ MSG: "sheet", REQ_ID: "d1", REQ_KIND: "dialog", REQ_TOOL: "bash", REQ_TEXT: "Allow?", REQ_INDEX: 1, REQ_COUNT: 2, VIBE: 1 }));
	assert.equal(m.vibe, true);
	// The face clears it once it has vibed; a later VIBE 0 does not set it.
	m.vibe = false;
	m.apply(M({ MSG: "sheet", REQ_ID: "d1", REQ_KIND: "dialog", REQ_TOOL: "bash", REQ_TEXT: "Allow?", REQ_INDEX: 1, REQ_COUNT: 1, VIBE: 0 }));
	assert.equal(m.vibe, false);
});
