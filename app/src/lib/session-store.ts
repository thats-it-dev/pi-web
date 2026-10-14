// One open session in the app: file history first, then the hub's snapshot,
// then live events folded with the same reducer the hub uses.

import type { Conversation, Dialog, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { applyEvent, createConversation } from "../../../shared/src/reducer.ts";
import type { HistoryResponse } from "./api.ts";
import { LiveStats } from "./live-stats.ts";
import type { StreamStatus } from "./stream.ts";

export type SessionStatus = "loading" | "history" | "starting" | "live" | "reconnecting";

export class SessionStore extends EventTarget {
	id: string;
	snapshot: Snapshot | null = null;
	conv: Conversation = createConversation();
	status: SessionStatus = "loading";
	dialogs: Dialog[] = [];
	dialogSeenAt = new Map<string, number>();
	cwdHint: string | null = null;
	nameHint: string | null = null;
	lastExit: string | null = null;
	live = new LiveStats(); // context and speed between the hub's per-turn stats

	constructor(id: string) {
		super();
		this.id = id;
	}

	setHistory(h: HistoryResponse): void {
		this.cwdHint = h.cwd;
		this.nameHint = h.name ?? null;
		this.lastExit = h.error ?? null;
		if (this.snapshot) return;
		this.conv = createConversation(h.messages);
		if (this.status === "loading") this.status = "history";
		this.changed();
	}

	markStarting(): void {
		if (this.snapshot) return;
		this.status = "starting";
		this.changed();
	}

	cancelStarting(): void {
		if (this.status === "starting") this.status = "history";
		this.changed();
	}

	setStreamStatus(s: StreamStatus): void {
		if (s === "reconnecting" && this.snapshot) this.status = "reconnecting";
		this.changed();
	}

	apply(msg: StreamMessage): void {
		switch (msg.type) {
			case "snapshot":
				this.snapshot = msg.snapshot;
				this.id = msg.snapshot.sessionId;
				this.conv = msg.snapshot.conv;
				this.live.reset(msg.snapshot.stats, msg.snapshot.conv.partial !== null);
				this.dialogs = [...msg.snapshot.dialogs];
				for (const d of this.dialogs) if (!this.dialogSeenAt.has(d.id)) this.dialogSeenAt.set(d.id, Date.now());
				this.cwdHint = msg.snapshot.cwd;
				this.status = "live";
				this.lastExit = null;
				this.dispatchEvent(new Event("snapshot"));
				break;
			case "detached":
				this.goOffline();
				if (this.status !== "starting") this.status = "history";
				break;
			case "event":
				applyEvent(this.conv, msg.event);
				this.live.onEvent(msg.event);
				break;
			case "meta":
				this.live.onStats(msg.stats);
				if (this.snapshot) Object.assign(this.snapshot, { state: msg.state, stats: msg.stats, statuses: msg.statuses, widgets: msg.widgets, thinkingLevels: msg.thinkingLevels, terminalPrompt: msg.terminalPrompt, approvalMode: msg.approvalMode });
				break;
			case "dialog":
				this.dialogs = [...this.dialogs.filter((d) => d.id !== msg.dialog.id), msg.dialog];
				this.dialogSeenAt.set(msg.dialog.id, Date.now());
				break;
			case "dialog_closed":
				this.dialogs = this.dialogs.filter((d) => d.id !== msg.id);
				break;
			case "handle_gone":
				this.goOffline();
				this.status = "history";
				this.lastExit = msg.reason === "exit" ? msg.stderr || "pi stopped unexpectedly." : null;
				break;
			default:
				this.dispatchEvent(new CustomEvent<StreamMessage>("notice", { detail: msg }));
		}
		this.changed();
	}

	// The process is gone (idle reap, crash, hub restart), so nothing will finish
	// the in-flight reply or running tools. Keep completed messages and finished
	// tool results; the "offline" event tells the view to refetch the file history.
	private goOffline(): void {
		const wasLive = this.snapshot !== null;
		this.snapshot = null;
		this.dialogs = [];
		if (!wasLive) return;
		const tools = Object.fromEntries(Object.entries(this.conv.tools).filter(([, t]) => !t.running));
		this.conv = { ...createConversation(), messages: this.conv.messages, tools };
		this.dispatchEvent(new Event("offline"));
	}

	private changed(): void {
		this.dispatchEvent(new Event("change"));
	}
}
