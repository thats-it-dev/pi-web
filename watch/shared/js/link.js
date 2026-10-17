// The watch's end of AppMessage: commands out, the phone's dicts in.
// A new Message starts suspended and may write only after onWritable; until
// then (and while a write is in flight) commands wait in a queue.
import Message from "pebble/message";
import Timer from "timer";

const INPUT_BYTES = 1100;
const OUTPUT_BYTES = 640;
const RETRY_MS = 100;
const MAX_TRIES = 10;

export function createLink({ keys, onMessage }) {
	const queue = [];
	const flushed = [];
	let cmdId = 0;
	let message = null;
	let retry;
	let failures = 0;

	const link = {
		writable: false,
		send(cmd, fields) {
			cmdId += 1;
			const map = new Map([["CMD", cmd], ["CMD_ID", cmdId]]);
			if (fields) {
				for (const k in fields) {
					const v = fields[k];
					if (v !== undefined && v !== null) map.set(k, v);
				}
			}
			queue.push(map);
			pump();
			return cmdId;
		},
		// fn runs on the next onWritable after the queue is empty (the last write went out).
		onFlushed(fn) {
			flushed.push(fn);
		},
	};

	function pump() {
		if (!link.writable || !message) return;
		if (!queue.length) {
			const fns = flushed.splice(0);
			for (const fn of fns) fn();
			return;
		}
		const map = queue[0];
		try {
			message.write(map);
			queue.shift();
			failures = 0;
			link.writable = false;
		} catch (e) {
			// The outbox can still be busy (the firmware's own ready message at launch):
			// keep the command at the head of the queue and try again shortly.
			failures += 1;
			if (failures >= MAX_TRIES) {
				console.log("pi-web: drop " + map.get("CMD") + ": " + e);
				queue.shift();
				failures = 0;
			}
			if (retry === undefined) {
				retry = Timer.set(() => {
					retry = undefined;
					pump();
				}, RETRY_MS);
			}
		}
	}

	// Buffers sized to what crosses the link instead of the 8 KB maximum each:
	// the phone packs every dict into 1000 bytes (bridge.js MSG_BYTES); commands are small.
	message = new Message({
		keys,
		input: INPUT_BYTES,
		output: OUTPUT_BYTES,
		onReadable() {
			let map;
			try {
				map = this.read();
			} catch (e) {
				console.log("pi-web: read failed: " + e);
				return;
			}
			onMessage(map);
		},
		onWritable() {
			link.writable = true;
			pump();
		},
		onSuspend() {
			link.writable = false;
		},
	});

	return link;
}
