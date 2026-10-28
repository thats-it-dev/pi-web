// POST /api/index/notes: the ring's second webhook. Same headers, multipart and de-duplication as
// the agent webhook (index-webhook.ts), but a note never touches pi: it is stored like an agent
// delivery and forwarded to the ring-profile service through the outbox (notes-outbox.ts).
// Once the headers pass the ring always gets 200, without waiting for the forward.

import type { IncomingMessage, ServerResponse } from "node:http";
import { KEEP, type ReplayCache, ack, noteSidecar, receiveRing } from "./index-webhook.ts";
import { prune, saveAudio, saveSidecar } from "./index-store.ts";
import type { NotesBody, Outbox, PostResult } from "./notes-outbox.ts";

export interface NotesDeps {
	dataDir: string;
	replays: ReplayCache; // shared with the agent webhook
	outbox?: Outbox; // absent when ringProfileUrl is "": the note is stored, not forwarded
	now?: () => number;
	log?: (m: string) => void;
	keep?: number;
}

export async function handleNotesWebhook(req: IncomingMessage, res: ServerResponse, deps: NotesDeps): Promise<void> {
	const log = deps.log ?? (() => {});
	const note = await receiveRing(req, res, { dataDir: deps.dataDir, replays: deps.replays, log }, "notes");
	if (!note) return;
	const { delivery, audio } = note;
	const receivedAt = (deps.now ?? Date.now)();
	let sent: Promise<PostResult> | null = null;
	// Queue first, and each step in its own try: a failed audio or sidecar save must not lose the note.
	if (deps.outbox) {
		try {
			const body: NotesBody = {
				dedupeKey: delivery,
				...(note.headers.delivery ? { deliveryId: note.headers.delivery } : {}),
				recordedAt: note.recordedMs ?? receivedAt,
				receivedAt,
				transcript: note.transcription,
				...(audio?.length ? { audioBase64: audio.toString("base64") } : {}),
				webhook: "notes",
			};
			sent = deps.outbox.add(delivery, body);
		} catch (e) {
			log(`notes: queue: ${(e as Error).message}`);
		}
	}
	try {
		if (audio) saveAudio(deps.dataDir, delivery, audio);
	} catch (e) {
		log(`notes: audio: ${(e as Error).message}`);
	}
	try {
		saveSidecar(deps.dataDir, delivery, { ...noteSidecar(note, note.transcription, receivedAt), action: sent ? "forwarded" : "stored" });
		prune(deps.dataDir, deps.keep ?? KEEP);
	} catch (e) {
		log(`notes: store: ${(e as Error).message}`);
	}
	ack(res);
	if (!sent) {
		if (!deps.outbox) log(`notes: ${delivery} stored`);
		return;
	}
	const r = await sent;
	log(`notes: ${delivery} ${r === true ? "forwarded" : r === "rejected" ? "rejected" : "queued"}`);
}
