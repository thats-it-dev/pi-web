import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageStore } from "../src/images.ts";

function png(w: number, h: number, pad = 0): Buffer {
	const b = Buffer.alloc(33 + pad);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	b.fill(7, 33);
	return b;
}
const block = (b: Buffer) => ({ type: "image", data: b.toString("base64"), mimeType: "image/png" });
const HEX = /^[0-9a-f]{64}$/;

function snapshot(a: Buffer, b: Buffer, c: Buffer, d: Buffer) {
	return {
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }, block(a)] },
			{ role: "toolResult", content: [block(b)], details: { image: block(d) } },
		],
		conv: { tools: { t1: { result: { content: [block(c)] } } } },
	};
}

test("outgoing replaces image data with a ref and leaves the input alone", () => {
	const bufs = [png(3, 4, 1), png(5, 6, 2), png(7, 8, 3), png(9, 10, 4)];
	const input = snapshot(bufs[0], bufs[1], bufs[2], bufs[3]);
	const before = structuredClone(input);
	const store = new ImageStore();
	const out = store.outgoing("s", input);
	assert.deepEqual(input, before);
	const json = JSON.stringify(out);
	for (const b of bufs) assert.ok(!json.includes(b.toString("base64")));
	const o = out as any;
	const imgs = [
		o.messages[0].content[1],
		o.messages[1].content[0],
		o.conv.tools.t1.result.content[0],
		o.messages[1].details.image,
	];
	for (const [i, im] of imgs.entries()) {
		assert.equal(im.type, "image");
		assert.equal(im.mimeType, "image/png");
		assert.match(im.ref, HEX);
		assert.equal("data" in im, false);
		assert.equal(im.width, 3 + 2 * i);
		assert.equal(im.height, 4 + 2 * i);
		assert.ok(store.has("s", im.ref));
	}
	assert.deepEqual(o.messages[0].content[0], { type: "text", text: "hi" });
});

test("get returns the bytes for a ref in that session only", () => {
	const store = new ImageStore();
	const b = png(2, 2);
	const out = store.outgoing("a", block(b)) as any;
	const got = store.get("a", out.ref);
	assert.equal(got?.mimeType, "image/png");
	assert.ok(got?.bytes.equals(b));
	assert.equal(store.get("b", out.ref), undefined);
	assert.equal(store.has("b", out.ref), false);
});

test("index records refs without copying", () => {
	const store = new ImageStore();
	const b = png(2, 2);
	const msgs = [{ role: "user", content: [block(b)] }];
	store.index("s", msgs as any);
	assert.equal(msgs[0].content[0].data, b.toString("base64"));
	const ref = (store.outgoing("other", block(b)) as any).ref;
	assert.ok(store.has("s", ref));
	assert.ok(store.get("s", ref)?.bytes.equals(b));
});

test("the LRU evicts by bytes but keeps membership", () => {
	const store = new ImageStore({ maxBytes: 150 });
	const a = (store.outgoing("s", block(png(1, 1, 67))) as any).ref;
	const b = (store.outgoing("s", block(png(2, 2, 67))) as any).ref;
	assert.equal(store.get("s", a), undefined);
	assert.equal(store.has("s", a), true);
	assert.ok(store.get("s", b));
});

test("identical images share one ref", () => {
	const store = new ImageStore();
	const x = store.outgoing("s", [block(png(2, 2)), block(png(2, 2))]) as any[];
	assert.equal(x[0].ref, x[1].ref);
});
