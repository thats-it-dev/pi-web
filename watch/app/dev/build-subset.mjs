// Emulator only: `pebble build` with only some views in the mod, for checking
// one screen when the full mod is too big to boot in the emulator (QEMU copies
// the whole archive into the app heap; see watch/README.md, "Code size is
// memory"). Home is always included (main.js opens it). Picking a screen that is
// left out aborts the app. The real manifest is restored afterwards, also on
// failure; never commit the temporary one.
//
//   cd watch/app && node dev/build-subset.mjs MenuView History
import { readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const app = new URL("..", import.meta.url).pathname;
const path = app + "src/embeddedjs/manifest.json";
// mcrun's make only relinks mc.xsa when a module is newer than it: drop the mods
// before (to relink without the left-out views) and after (so the next full
// build relinks; the subset's .pbw stays in build/ for `pebble install`).
const mods = () => rmSync(app + "build/mods", { recursive: true, force: true });
const views = process.argv.slice(2);
if (!views.length) {
	console.error("usage: node dev/build-subset.mjs <View…>");
	process.exit(2);
}
const real = readFileSync(path, "utf8");
const manifest = JSON.parse(real);
const names = [...new Set(["Home", ...views])];
manifest.modules["*"] = manifest.modules["*"].filter((m) => m !== "./views/*").concat(names.map((v) => "./views/" + v));
process.on("SIGINT", () => {}); // let the build stop and the manifest come back
let status = 1;
try {
	mods();
	writeFileSync(path, JSON.stringify(manifest, null, "\t") + "\n");
	console.log("build-subset: views " + names.join(", "));
	status = spawnSync("pebble", ["build"], { cwd: app, stdio: "inherit" }).status ?? 1;
	if (!status) console.log("build-subset: emery mc.xsa " + statSync(app + "build/mods/emery/mc.xsa").size + " B");
} finally {
	writeFileSync(path, real);
	mods();
}
process.exit(status);
