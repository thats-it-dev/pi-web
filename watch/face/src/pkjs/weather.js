// The weather corner's phone side: the phone's position, then the hub's
// GET /api/watch/weather every 20 minutes. ES5 only; all dependencies are injected.

var TICK_MS = 20 * 60 * 1000;
var GEO_OPTS = { timeout: 15000, maximumAge: 600000 };

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

	function emit() {
		if (tempC !== null) deps.onTemp(formatTemp(tempC, unit));
	}

	function schedule() {
		if (timer !== null) deps.clearTimeout(timer);
		timer = deps.setTimeout(function () {
			timer = null;
			refresh();
		}, TICK_MS);
	}

	function refresh() {
		var mine = ++gen;
		schedule();
		var geo = deps.geolocation;
		if (!geo) {
			deps.onTemp("");
			return;
		}
		geo.getCurrentPosition(
			function (pos) {
				if (!running || mine !== gen) return;
				var c = pos && pos.coords;
				if (!c) {
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
					tempC = json.tempC;
					emit();
				});
			},
			function () {
				if (!running || mine !== gen) return;
				log("pi-web: no position for the weather");
				deps.onTemp("");
			},
			GEO_OPTS
		);
	}

	return {
		start: function (u) {
			if (u === "C" || u === "F") unit = u;
			running = true;
			refresh();
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
