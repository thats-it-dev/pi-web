import { expect, test } from "vitest";
import { sessionImageLoader } from "./session-images.ts";

test("image fetches use the store's current id, not the one the view opened with", async () => {
	const store = { id: "old" };
	const calls: string[] = [];
	const api = { image: async (id: string, ref: string) => (calls.push(`${id}/${ref}`), new Blob([])) };
	const loader = sessionImageLoader(api, store, () => "blob:x", () => {});
	await loader.load("a");
	store.id = "new";
	await loader.load("b");
	expect(calls).toEqual(["old/a", "new/b"]);
});
