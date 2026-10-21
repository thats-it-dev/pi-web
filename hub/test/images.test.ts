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

test("a second outgoing of the same block does not decode or replace the stored bytes", () => {
	const store = new ImageStore();
	const blk = block(png(2, 2));
	const r1 = (store.outgoing("s", blk) as any).ref;
	const first = store.get("s", r1)?.bytes;
	const r2 = (store.outgoing("s", { content: [blk] }) as any).content[0].ref;
	assert.equal(r2, r1);
	assert.equal(store.get("s", r1)?.bytes, first);
});

test("re-adding an existing ref keeps byte accounting right", () => {
	const store = new ImageStore({ maxBytes: 100 });
	const a = (store.outgoing("s", block(png(1, 1, 7))) as any).ref; // 40 bytes
	store.outgoing("s", block(png(1, 1, 7)));
	store.outgoing("s", block(png(1, 1, 7)));
	const b = (store.outgoing("s", block(png(2, 2, 7))) as any).ref; // 80 total
	assert.ok(store.get("s", a));
	assert.ok(store.get("s", b));
	store.outgoing("s", block(png(3, 3, 7))); // 120 > 100, evicts the oldest only
	assert.equal(store.get("s", a), undefined);
	assert.ok(store.get("s", b));
});

test("an image larger than the cache is a member but evicts nothing", () => {
	const store = new ImageStore({ maxBytes: 100 });
	const small = (store.outgoing("s", block(png(1, 1))) as any).ref;
	const big = (store.outgoing("t", block(png(2, 2, 200))) as any).ref;
	assert.equal(store.has("t", big), true);
	assert.equal(store.get("t", big), undefined);
	assert.ok(store.get("s", small));
});

test("unrecognised bytes are octet-stream; sniffed type beats the declared one", () => {
	const store = new ImageStore();
	const junk = { type: "image", data: Buffer.from("<script>").toString("base64"), mimeType: "text/html" };
	const j = store.outgoing("s", junk) as any;
	assert.equal(j.mimeType, "application/octet-stream");
	assert.equal(store.get("s", j.ref)?.mimeType, "application/octet-stream");
	assert.equal("data" in j, false);
	const p = store.outgoing("s", { ...block(png(2, 2)), mimeType: "image/jpeg" }) as any;
	assert.equal(p.mimeType, "image/png");
	assert.equal(store.get("s", p.ref)?.mimeType, "image/png");
});

test("an image block without a string mimeType still loses its data", () => {
	const store = new ImageStore();
	const b = png(2, 2);
	const out = store.outgoing("s", [{ type: "image", data: b.toString("base64") }, { type: "image", data: b.toString("base64"), mimeType: 5 }]) as any[];
	for (const o of out) {
		assert.equal("data" in o, false);
		assert.equal(o.mimeType, "image/png");
		assert.match(o.ref, HEX);
	}
});

test("conv.tools partialResult images are rewritten", () => {
	const store = new ImageStore();
	const b = png(2, 2);
	const out = store.outgoing("s", { conv: { tools: { t: { partialResult: { content: [block(b)] } } } } }) as any;
	assert.ok(!JSON.stringify(out).includes(b.toString("base64")));
	assert.match(out.conv.tools.t.partialResult.content[0].ref, HEX);
});
