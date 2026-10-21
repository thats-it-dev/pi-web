import { describe, expect, it } from "vitest";
import { ImageLoader } from "./image-loader.ts";

function setup(fail = 0) {
	let fetches = 0;
	let n = 0;
	const revoked: string[] = [];
	const loader = new ImageLoader(
		async () => {
			fetches++;
			if (fetches <= fail) throw new Error("boom");
			return new Blob(["x"]);
		},
		() => `blob:${++n}`,
		(u) => revoked.push(u),
	);
	return { loader, revoked, fetches: () => fetches };
}

describe("ImageLoader", () => {
	it("two elements with one ref fetch once", async () => {
		const { loader, fetches } = setup();
		const [a, b] = await Promise.all([loader.load("r"), loader.load("r")]);
		expect(a).toBe(b);
		expect(fetches()).toBe(1);
	});
	it("a failed fetch leaves the unavailable state", async () => {
		const { loader, fetches } = setup(1);
		await expect(loader.load("r")).rejects.toThrow();
		await expect(loader.load("r")).resolves.toMatch(/^blob:/);
		expect(fetches()).toBe(2);
	});
	it("dispose revokes every url", async () => {
		const { loader, revoked } = setup();
		const a = await loader.load("a");
		const b = await loader.load("b");
		loader.dispose();
		expect(revoked.sort()).toEqual([a, b].sort());
	});
});
