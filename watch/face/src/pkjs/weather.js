// The weather corner's phone side: the phone's position, then the hub's
// GET /api/watch/weather every 20 minutes. ES5 only; all dependencies are injected.

var TICK_MS = 20 * 60 * 1000;
var GEO_OPTS = { timeout: 15000, maximumAge: 600000 };
// The last reading and when it was taken: the face's JS restarts after every
// visit to the app, and a reading under 20 minutes old is shown without a fetch.
var CACHE_KEY = "pi-web.weather";

function formatTemp(tempC, unit) {
	if (typeof tempC !== "number" || tempC !== tempC) return "";
	var t = unit === "F" ? (tempC * 9) / 5 + 32 : tempC;
	return Math.round(t) + "°";
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

function createWeather(deps) {
	var unit = "C";
	var tempC = null;
	var timer = null;
	var running = false;
	var gen = 0;
	var log = deps.log || function () {};

	function save(t) {
		tempC = t;
		if (!deps.storage) return;
		try {
			if (t === null) deps.storage.removeItem(CACHE_KEY);
			else deps.storage.setItem(CACHE_KEY, JSON.stringify({ tempC: t, at: deps.now() }));
		} catch (e) {}
	}

	// The age of a cached reading it adopts, or -1.
	function load() {
		var c = null;
		try {
			c = deps.storage && JSON.parse(deps.storage.getItem(CACHE_KEY));
		} catch (e) {}
		var age = c && typeof c.tempC === "number" && typeof c.at === "number" ? deps.now() - c.at : -1;
		if (age < 0 || age >= TICK_MS) return -1;
		tempC = c.tempC;
		return age;
	}

	function emit() {
		if (tempC !== null) deps.onTemp(formatTemp(tempC, unit));
	}

	function schedule(ms) {
		if (timer !== null) deps.clearTimeout(timer);
		timer = deps.setTimeout(function () {
			timer = null;
			refresh();
		}, ms || TICK_MS);
	}

	function refresh() {
		var mine = ++gen;
		schedule();
		var geo = deps.geolocation;
		if (!geo) {
			save(null);
			deps.onTemp("");
			return;
		}
		geo.getCurrentPosition(
			function (pos) {
				if (!running || mine !== gen) return;
				var c = pos && pos.coords;
				if (!c) {
					save(null);
					deps.onTemp("");
					return;
				}
				var path = "/api/watch/weather?lat=" + round2(c.latitude) + "&lon=" + round2(c.longitude);
				deps.hub.get(path, function (err, json) {
					if (!running || mine !== gen) return;
					if (err || !json || typeof json.tempC !== "number") {
						log("pi-web: weather fetch failed");
						return;
					}
					save(json.tempC);
					emit();
				});
			},
			function () {
				if (!running || mine !== gen) return;
				log("pi-web: no position for the weather");
				// Forget the reading too, so setUnit cannot bring back an old one.
				save(null);
				deps.onTemp("");
			},
			GEO_OPTS
		);
	}

	return {
		start: function (u) {
			if (u === "C" || u === "F") unit = u;
			running = true;
			var age = load();
			if (age < 0) {
				refresh();
				return;
			}
			gen++;
			emit();
			schedule(TICK_MS - age);
		},
		setUnit: function (u) {
			if (u !== "C" && u !== "F") return;
			unit = u;
			emit();
		},
		stop: function () {
			running = false;
			gen++;
			if (timer !== null) deps.clearTimeout(timer);
			timer = null;
		},
	};
}

module.exports = { createWeather: createWeather, formatTemp: formatTemp };
