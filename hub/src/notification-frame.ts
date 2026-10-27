// The BlobDB Notification insert the phone's Developer Connection relays to the watch
// (verified on hardware, spec §7 "Spike results"; hub/test/fixtures/notification-frame.hex).
// Packet: 0x01 RelayToWatch | length u16 BE | endpoint 0xB1DB u16 BE | payload. The payload
// is BlobDB INSERT (token u16 LE, database 4 = notification, a 16-byte key, the item).
// Everything inside the payload is little-endian. Actions: Open launches the watchapp with
// the launch code (OpenWatchapp 0x07), Dismiss just closes the notification (0x04).

import { UUID_RE } from "./watch-launch.ts";

export interface NotificationInput {
	appUuid: string;
	itemId: string;
	token: number; // u16, echoed back by the watch's BlobDB reply
	title: string;
	body: string;
	launchCode: number; // u32
	time: number; // seconds since the epoch
}

const ATTR_TITLE = 0x01;
const ATTR_BODY = 0x03;
const ATTR_ACTION_TITLE = 0x01;
const ATTR_LAUNCH_CODE = 0x0d;
const ACTION_DISMISS = 0x04;
const ACTION_OPEN_WATCHAPP = 0x07;
const ENDPOINT_BLOBDB = 0xb1db;

const uuidBytes = (u: string): Buffer => {
	if (!UUID_RE.test(u)) throw new Error("A valid uuid is required");
	return Buffer.from(u.replaceAll("-", ""), "hex");
};

const u16 = (n: number): Buffer => {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(n);
	return b;
};

const attr = (id: number, bytes: Buffer): Buffer => Buffer.concat([Buffer.from([id]), u16(bytes.length), bytes]);

function action(id: number, type: number, attrs: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from([id, type, attrs.length]), ...attrs]);
}

export function notificationFrame(input: NotificationInput): Uint8Array {
	const appUuid = uuidBytes(input.appUuid);
	const itemId = uuidBytes(input.itemId);
	const code = Buffer.alloc(4);
	code.writeUInt32LE(input.launchCode >>> 0);
	const attrs = [attr(ATTR_TITLE, Buffer.from(input.title)), attr(ATTR_BODY, Buffer.from(input.body))];
	const actions = [action(0, ACTION_OPEN_WATCHAPP, [attr(ATTR_ACTION_TITLE, Buffer.from("Open")), attr(ATTR_LAUNCH_CODE, code)]), action(1, ACTION_DISMISS, [attr(ATTR_ACTION_TITLE, Buffer.from("Dismiss"))])];
	const data = Buffer.concat([...attrs, ...actions]);

	const head = Buffer.alloc(16 + 16 + 4 + 2 + 1 + 2 + 1 + 2 + 1 + 1); // header of the item, up to the attributes
	let o = itemId.copy(head, 0);
	o += appUuid.copy(head, o);
	head.writeUInt32LE(input.time >>> 0, o);
	o += 4;
	o += 2; // duration 0
	head[o++] = 1; // type: notification
	o += 2; // flags 0
	head[o++] = 4; // layout
	head.writeUInt16LE(data.length, o);
	o += 2;
	head[o++] = attrs.length;
	head[o++] = actions.length;
	const item = Buffer.concat([head, data]);

	const payload = Buffer.concat([Buffer.from([0x01]), u16(input.token), Buffer.from([0x04, 16]), itemId, u16(item.length), item]);
	const out = Buffer.alloc(5 + payload.length);
	out[0] = 0x01; // RelayToWatch
	out.writeUInt16BE(payload.length, 1);
	out.writeUInt16BE(ENDPOINT_BLOBDB, 3);
	payload.copy(out, 5);
	return new Uint8Array(out);
}
