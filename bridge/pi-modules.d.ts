// pi provides these modules to extensions at runtime (pi's virtual modules);
// the bridge declares only what it uses so it typechecks without depending on pi.

declare module "@earendil-works/pi-coding-agent" {
	export const VERSION: string;
	export function buildSessionContext(entries: unknown[], leafId?: string | null): { messages: unknown[] };
}

declare module "@earendil-works/pi-ai" {
	export function getSupportedThinkingLevels(model: unknown): string[];
}
