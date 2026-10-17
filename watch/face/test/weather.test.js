const test = require("node:test");
const assert = require("node:assert/strict");
const { createWeather, formatTemp } = require("../src/pkjs/weather.js");
const { FakeTimers } = require("../../app/test/support/fakes.js");

const TICK = 20 * 60 * 1000;

function setup() {
	const timers = new FakeTimers();
	const temps = [];
	const gets = [];
	const geo = { calls: [], opts: [] };
	const hub = { get: (path, cb) => gets.push({ path, cb }) };
	const geolocation = {
		getCurrentPosition(ok, fail, opts) {
			geo.calls.push({ ok, fail });
			geo.opts.push(opts);
		},
	};
	const w = createWeather({
		hub,
		geolocation,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		now: () => 0,
		log: () => {},
		onTemp: (t) => temps.push(t),
	});
	const fix = (lat, lon) => geo.calls[geo.calls.length - 1].ok({ coords: { latitude: lat, longitude: lon } });
	return { w, timers, temps, gets, geo, fix };
}

test("formatTemp rounds and converts", () => {
	assert.equal(formatTemp(11.5, "C"), "12°");
	assert.equal(formatTemp(11.5, "F"), "53°");
	assert.equal(formatTemp(-0.4, "C"), "0°");
	assert.equal(formatTemp(null, "C"), "");
	assert.equal(formatTemp(undefined, "F"), "");
	assert.equal(formatTemp("x", "C"), "");
});

test("start asks geolocation once, fetches with 2-decimal coordinates and emits", () => {
	const s = setup();
	s.w.start("C");
	assert.equal(s.geo.calls.length, 1);
	assert.deepEqual(s.geo.opts[0], { timeout: 15000, maximumAge: 600000 });
	assert.equal(s.gets.length, 0);
	s.fix(52.520008, 13.404954);
	assert.equal(s.gets.length, 1);
	assert.equal(s.gets[0].path, "/api/watch/weather?lat=52.52&lon=13.4");
	s.gets[0].cb(null, { tempC: 11.5, code: 3 });
	assert.deepEqual(s.temps, ["12°"]);
});

test("refetches after 20 minutes, not before", () => {
	const s = setup();
	s.w.start("C");
	s.fix(1, 2);
	s.gets[0].cb(null, { tempC: 11.5 });
	assert.deepEqual(s.timers.pending(), [TICK]);
	assert.equal(s.geo.calls.length, 1);
	s.timers.fire(0);
	assert.equal(s.geo.calls.length, 2);
	s.fix(1, 2);
	s.gets[1].cb(null, { tempC: 20 });
	assert.deepEqual(s.temps, ["12°", "20°"]);
	assert.deepEqual(s.timers.pending(), [TICK]);
});

test("a failed fetch keeps the last text and retries at the next tick", () => {
	const s = setup();
	s.w.start("C");
	s.fix(1, 2);
	s.gets[0].cb(null, { tempC: 11.5 });
	s.timers.fire(0);
	s.fix(1, 2);
	s.gets[1].cb(new Error("down"));
	assert.deepEqual(s.temps, ["12°"]);
	assert.deepEqual(s.timers.pending(), [TICK]);
	s.timers.fire(0);
	assert.equal(s.geo.calls.length, 3);
	s.fix(1, 2);
	s.gets[2].cb(null, { tempC: 3 });
	assert.deepEqual(s.temps, ["12°", "3°"]);
});

test("a reply without a number keeps the last text", () => {
	const s = setup();
	s.w.start("C");
	s.fix(1, 2);
	s.gets[0].cb(null, { tempC: 11.5 });
	s.timers.fire(0);
	s.fix(1, 2);
	s.gets[1].cb(null, { nope: 1 });
	assert.deepEqual(s.temps, ["12°"]);
});

test("setUnit re-emits from the cached temperature without a fetch", () => {
	const s = setup();
	s.w.start("C");
	s.fix(1, 2);
	s.gets[0].cb(null, { tempC: 11.5 });
	s.w.setUnit("F");
	assert.deepEqual(s.temps, ["12°", "53°"]);
	assert.equal(s.gets.length, 1);
	assert.equal(s.geo.calls.length, 1);
});

test("setUnit with nothing cached emits nothing", () => {
	const s = setup();
	s.w.setUnit("F");
	assert.deepEqual(s.temps, []);
});

test("geolocation failure emits an empty text and retries at the next tick", () => {
	const s = setup();
	s.w.start("C");
	s.geo.calls[0].fail({ code: 1 });
	assert.deepEqual(s.temps, [""]);
	assert.equal(s.gets.length, 0);
	assert.deepEqual(s.timers.pending(), [TICK]);
	s.timers.fire(0);
	assert.equal(s.geo.calls.length, 2);
});

test("stop cancels the timer and ignores late replies; a second start does not double the timers", () => {
	const s = setup();
	s.w.start("C");
	s.w.start("C");
	assert.equal(s.timers.pending().length, 1);
	s.fix(1, 2);
	s.w.stop();
	assert.deepEqual(s.timers.pending(), []);
	s.gets[s.gets.length - 1].cb(null, { tempC: 5 });
	assert.deepEqual(s.temps, []);
});
