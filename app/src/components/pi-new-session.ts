import { LitElement, css, html } from "lit";
import { sharedStyles, toast } from "@thatsit/kit";
import type { HubApi } from "../lib/api.ts";
import { abbreviateCwd } from "../lib/format.ts";
import { hrefFor } from "../lib/route.ts";

export class PiNewSession extends LitElement {
	static properties = { api: { attribute: false }, cwd: { attribute: false }, cwds: { state: true }, home: { state: true }, path: { state: true }, busy: { state: true } };
	declare api: HubApi;
	declare cwd: string | null;
	declare cwds: string[];
	declare home: string;
	declare path: string;
	declare busy: boolean;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; overflow-y: auto; height: 100%; }
			.wrap { max-width: 560px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top)) 18px 40px; }
			.menu { display: none; font-size: 1.4rem; margin-bottom: 8px; }
			h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 2rem; margin: 0 0 18px; }
			form { display: grid; gap: 10px; }
			.folders { display: flex; flex-wrap: wrap; gap: 6px; }
			.folder { border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 10px; font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-secondary); }
			.folder.on { border-color: var(--primary); color: var(--text-primary); background: color-mix(in srgb, var(--primary), transparent 85%); }
			input { width: 100%; font-family: var(--font-mono); }
			.btn { justify-self: start; }
			.hint { color: var(--text-secondary); font-size: 0.85rem; margin: 0; }
			@media (max-width: 899px) { .menu { display: inline-block; } }
		`,
	];

	constructor() {
		super();
		this.cwd = null;
		this.cwds = [];
		this.home = "";
		this.path = "";
		this.busy = false;
	}

	connectedCallback(): void {
		super.connectedCallback();
		if (this.cwd) this.path = this.cwd;
		this.api
			.cwds()
			.then((r) => {
				this.cwds = r.cwds;
				this.home = r.home;
				if (!this.path) this.path = r.cwds[0] ?? r.home;
			})
			.catch((e: Error) => toast(e.message, "error"));
	}

	private async start(e: Event): Promise<void> {
		e.preventDefault();
		const cwd = this.path.trim();
		if (!cwd || this.busy) return;
		this.busy = true;
		try {
			const { sessionId } = await this.api.createSession(cwd);
			location.hash = hrefFor({ name: "session", id: sessionId });
		} catch (err) {
			toast((err as Error).message, "error");
		} finally {
			this.busy = false;
		}
	}

	render() {
		return html`<div class="wrap">
			<button class="menu" aria-label="Open sessions" @click=${() => this.dispatchEvent(new CustomEvent("tk-open-nav", { bubbles: true, composed: true }))}>☰</button>
			<h1>new session</h1>
			<form @submit=${this.start}>
				${this.cwds.length ? html`<span class="label">recent folders</span>
					<div class="folders">${this.cwds.map((c) => html`<button type="button" class="folder ${c === this.path ? "on" : ""}" @click=${() => (this.path = c)}>${abbreviateCwd(c, this.home)}</button>`)}</div>` : ""}
				<label class="label" for="path">folder path</label>
				<input id="path" aria-label="Folder path" .value=${this.path} @input=${(e: Event) => (this.path = (e.target as HTMLInputElement).value)} placeholder="~/workspace/project" autocapitalize="off" autocomplete="off" spellcheck="false" />
				<button class="btn" type="submit" ?disabled=${this.busy || !this.path.trim()}>${this.busy ? "starting pi…" : "start session"}</button>
				<p class="hint">pi starts in this folder. Pick the model once it's running.</p>
			</form>
		</div>`;
	}
}
customElements.define("pi-new-session", PiNewSession);
