import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { sharedStyles } from "@thatsit/kit";
import type { SubagentChild } from "../../../shared/src/progress.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import type { Conversation } from "../../../shared/src/protocol.ts";
import type { HubApi } from "../lib/api.ts";
import { childThreadPolls } from "../lib/child-poll.ts";
import { hrefFor } from "../lib/route.ts";
import { GLYPH } from "../render/progress.ts";
import "./pi-messages.ts";

const POLL_MS = 2000;

// One subagent's transcript, read-only: there is no input here and nothing that steers or stops the child.
// While the parent is live it re-reads the transcript every 2 s until the child is finished; a failed
// read (the child may not have written its file yet) is retried the same way.
export class PiChildThread extends LitElement {
	static properties = {
		api: { attribute: false },
		sessionId: { attribute: false },
		childKey: { attribute: false },
		heading: { attribute: false },
		live: { attribute: false },
		child: { state: true },
		conv: { state: true },
		error: { state: true },
	};
	declare api: Pick<HubApi, "childHistory"> | null;
	declare sessionId: string;
	declare childKey: string;
	declare heading: string; // the parent's title
	declare live: boolean; // the parent session is live
	declare child: SubagentChild | null;
	declare conv: Conversation | null;
	declare error: string | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private seq = 0;
	private busy = false;

	static styles = [
		sharedStyles,
		css`
			:host { flex: 1; min-height: 0; display: flex; flex-direction: column; }
			tk-header h1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.crumb { color: var(--text-secondary); font-weight: 400; }
			.glyph { display: inline-block; width: 1.2em; text-align: center; color: var(--text-secondary); }
			.glyph.running { color: var(--primary); }
			.glyph.done { color: var(--success); }
			.glyph.failed { color: var(--accent); }
			.tag { flex: none; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; }
			.scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
			.msg { padding: 24px 18px; color: var(--text-secondary); font-size: 0.9rem; }
			.bar { flex: none; display: flex; gap: 6px; align-items: baseline; justify-content: center; padding: 12px 14px calc(12px + var(--safe-bottom)); border-top: 1px solid var(--line); background: var(--panel); font-size: 0.85rem; color: var(--text-secondary); }
			.bar button { color: var(--primary); font: inherit; text-decoration: underline; }
		`,
	];

	constructor() {
		super();
		this.api = null;
		this.sessionId = "";
		this.childKey = "";
		this.heading = "";
		this.live = false;
		this.child = null;
		this.conv = null;
		this.error = null;
	}

	willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("sessionId") || changed.has("childKey") || changed.has("api")) {
			this.child = null;
			this.conv = null;
			this.error = null;
			this.stopPoll();
			void this.fetch();
		}
		if (changed.has("live")) this.syncPoll();
	}

	connectedCallback(): void {
		super.connectedCallback();
		// A reconnect (not the first connect, which willUpdate covers) resumes.
		if (this.hasUpdated) void this.fetch();
	}

	disconnectedCallback(): void {
		this.stopPoll();
		this.busy = false;
		this.seq++; // a response in flight is dropped
		super.disconnectedCallback();
	}

	private async fetch(): Promise<void> {
		if (!this.api || !this.sessionId || !this.childKey) return;
		const seq = ++this.seq;
		this.busy = true;
		try {
			const r = await this.api.childHistory(this.sessionId, this.childKey);
			if (seq !== this.seq) return;
			this.child = r.child;
			this.conv = createConversation(r.messages);
			this.error = null;
		} catch {
			if (seq !== this.seq) return;
			// A failed refresh keeps what is on screen; only an empty thread says why.
			if (!this.conv) this.error = "This subagent's transcript isn't available.";
		} finally {
			if (seq === this.seq) {
				this.busy = false;
				this.syncPoll();
			}
		}
	}

	private polling(): boolean {
		return this.isConnected && childThreadPolls(this.live, this.child);
	}

	private syncPoll(): void {
		if (!this.polling()) return this.stopPoll();
		if (this.timer === undefined) this.timer = setInterval(() => !this.busy && void this.fetch(), POLL_MS);
	}

	private stopPoll(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}

	private back = () => {
		location.hash = hrefFor({ name: "session", id: this.sessionId });
	};

	render() {
		const c = this.child;
		return html`
			<tk-header menu-label="Open sessions">
				<h1 slot="title">
					<span class="crumb">${this.heading} ›</span>
					${c ? html`<span class="glyph ${c.state}" role="img" aria-label=${c.state}>${GLYPH[c.state]}</span>${c.agent} · ${c.task}` : nothing}
				</h1>
				<span slot="actions" class="tag">read-only</span>
			</tk-header>
			<div class="scroll">
				${this.error ? html`<div class="msg" role="status">${this.error}</div>` : this.conv ? html`<pi-messages .conv=${this.conv}></pi-messages>` : html`<div class="msg">Loading…</div>`}
			</div>
			<div class="bar">viewing a subagent · <button @click=${this.back}>back to parent</button></div>
		`;
	}
}
customElements.define("pi-child-thread", PiChildThread);
