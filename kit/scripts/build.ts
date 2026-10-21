import { execFileSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { collectSurface } from "./surface.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const themeDir = dirname(require.resolve("@thatsit/theme/theme.css"));

// Vite empties dist first, so it has to run before anything else lands there.
await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "warn" });

// Apps load one stylesheet; inline the theme so they need no second request or bundler.
const theme = await readFile(join(themeDir, "theme.css"), "utf8");
const kitCss = (await readFile(join(root, "src/kit.css"), "utf8")).replace(
	/^@import\s+["']@thatsit\/theme\/theme\.css["'];?[ \t]*$/m,
	() => theme,
);
await writeFile(join(dist, "kit.css"), kitCss);

await cp(join(themeDir, "fonts"), join(dist, "fonts"), { recursive: true });
await cp(join(root, "src/theme-init.js"), join(dist, "theme-init.js"));
await cp(join(root, "public/_headers"), join(dist, "_headers"));
const demo = join(root, "demo/index.html");
if (existsSync(demo)) await cp(demo, join(dist, "index.html"));

execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")], {
	cwd: root,
	stdio: "inherit",
});
await writeFile(join(dist, "kit.d.ts"), 'export * from "./types/index.js";\n');

await writeFile(join(dist, "api.json"), `${JSON.stringify(await collectSurface(dist), null, "\t")}\n`);
