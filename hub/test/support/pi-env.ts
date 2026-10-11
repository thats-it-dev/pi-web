// A throwaway PI_CODING_AGENT_DIR: fake provider with two models, no user
// extensions, plus a tiny /ask extension for dialog tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PiEnv {
	root: string;
	agentDir: string;
	workDir: string;
	piBin: string;
	env: Record<string, string>;
	cleanup(): void;
}

export const ASK_EXTENSION = `
export default function (pi) {
	pi.registerCommand("ask", {
		description: "test dialog",
		handler: async (_args, ctx) => {
			const value = await ctx.ui.select("Pick one", ["red", "blue"]);
			ctx.ui.notify("picked " + value, "info");
		},
	});
}
`;

export function makePiEnv(opts: { modelUrl: string; extensions?: Record<string, string>; settings?: Record<string, unknown> }): PiEnv {
	const root = mkdtempSync(join(tmpdir(), "pi-web-pi-"));
	const agentDir = join(root, "agent");
	const workDir = join(root, "work");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(workDir);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: opts.modelUrl,
					api: "openai-completions",
					apiKey: "test",
					compat: { supportsDeveloperRole: false },
					models: [
						{ id: "fake-a", name: "Fake A", reasoning: true, input: ["text", "image"], contextWindow: 1000, maxTokens: 100 },
						{ id: "fake-b", name: "Fake B", reasoning: false, input: ["text"], contextWindow: 2000, maxTokens: 100 },
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-a", ...opts.settings }));
	for (const [name, source] of Object.entries({ "ask.ts": ASK_EXTENSION, ...opts.extensions })) {
		writeFileSync(join(agentDir, "extensions", name), source);
	}
	return {
		root,
		agentDir,
		workDir,
		piBin: process.env.PI_BIN ?? "pi",
		env: { PI_CODING_AGENT_DIR: agentDir },
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
