import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const litEntry = resolve(here, "src/lit.ts");

export default defineConfig({
	publicDir: false,
	build: {
		outDir: "dist",
		emptyOutDir: true,
		lib: {
			entry: { kit: resolve(here, "src/index.ts"), lit: litEntry },
			formats: ["es"],
			fileName: (_format, name) => `${name}.js`,
		},
		rollupOptions: {
			// Lit stays external everywhere except inside lit.ts, so it is bundled exactly once (lit.js)
			// and every other module reaches it through the one shared URL.
			external: (id, importer) => /^lit(\/|$)/.test(id) && importer !== litEntry,
			output: { paths: (id) => (/^lit(\/|$)/.test(id) ? "./lit.js" : id) },
		},
	},
});
