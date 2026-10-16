import { LitElement, css, html, nothing } from "lit";
import { HubApi } from "../lib/api.ts";
import { type ThemePref, getHubUrl, getTheme, normalizeHubUrl, setHubUrl, setTheme } from "../lib/settings.ts";
import { PUSH_COPY, type PushStatus, browserPushEnv, disablePush, enablePush, pushStatus } from "../lib/push.ts";
import { sharedStyles } from "../styles/shared.ts";
import type { HealthInfo, UpdateStatus } from "../../../shared/src/protocol.ts";
import { toast } from "../lib/toast.ts";
import { watchSectionCopy } from "../lib/watch-settings.ts";
import { setVpDebug, vpDebugOn } from "../lib/vp-debug.ts";

export class PiSettings extends LitElement {
	static properties = { url: { state: true }, status: { state: true }, checking: { state: true }, theme: { state: true }, push: { state: true }, pushBusy: { state: true }, pushError: { state: true }, updateInfo: { state: true }, updateBusy: { state: true }, updateNote: { state: true }, health: { state: true } };
	declare url: string;
	declare status: { ok: boolean; text: string } | null;
	declare checking: boolean;
	declare theme: ThemePref;
	declare push: PushStatus | null;
	declare pushBusy: boolean;
	declare pushError: string | null;
	declare updateInfo: UpdateStatus | null; // the last check
	declare updateBusy: "checking" | "updating" | "restarting" | null;
	declare updateNote: { ok: boolean; text: string; force?: boolean } | null;
	declare health: HealthInfo | null;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; overflow-y: auto; height: 100%; }
			.wrap { max-width: 560px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top)) 18px 40px; display: grid; gap: 14px; }
			h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 2rem; margin: 0; }
			h2 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.08em; font-size: 1.2rem; margin: 18px 0 0; }
			label { font-family: var(--font-display); letter-spacing: 0.06em; }
			.hint { color: var(--text-secondary); font-size: 0.85rem; margin: 0; }
			code { font-family: var(--font-mono); font-size: 0.85em; }
			form { display: grid; gap: 8px; }
			.row { display: flex; gap: 8px; }
			.row input { flex: 1; min-width: 0; }
			.row code { flex: 1; min-width: 0; overflow-wrap: anywhere; user-select: all; align-self: center; }
			.status.ok { color: var(--success); }
			.status.bad { color: var(--accent); }
			a.back { font-family: var(--font-quote); }
		`,
	];

	constructor() {
		super();
		this.url = getHubUrl() ?? "";
		this.status = null;
		this.checking = false;
		this.theme = getTheme();
		this.push = null;
		this.pushBusy = false;
		this.pushError = null;
		this.updateInfo = null;
		this.updateBusy = null;
		this.updateNote = null;
		this.health = null;
	}

	// ---- watch pairing --------------------------------------------------------

	private async loadHealth(): Promise<void> {
		const url = getHubUrl();
		if (!url) return;
		try {
			this.health = await new HubApi(url).health();
		} catch {
			this.health = null;
		}
	}

	private async copy(value: string, el: HTMLElement | null): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			toast("Copied.");
		} catch {
			// Clipboard blocked: select the text so it can be copied by hand.
			const node = el?.firstChild;
			if (node) {
				const range = document.createRange();
				range.selectNodeContents(el as HTMLElement);
				const sel = getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
		}
	}

	private renderWatch() {
		if (!getHubUrl()) return html`<p class="hint">Connect to a hub first.</p>`;
		const w = watchSectionCopy(this.health);
		const rowFor = (label: string, value: string | null, id: string) =>
			value
				? html`<div class="row">
						<span>${label}</span>
						<code id=${id}>${value}</code>
						<button class="btn ghost" @click=${() => this.copy(value, this.renderRoot.querySelector<HTMLElement>(`#${id}`))}>copy</button>
					</div>`
				: nothing;
		return html`${rowFor("token", w.token, "watch-token")}${rowFor("Index secret", w.secret, "watch-secret")}<p class="hint">${w.hint}</p>`;
	}

	// ---- hub self-update ------------------------------------------------------

	private async checkUpdate(): Promise<void> {
		const url = getHubUrl();
		if (!url || this.updateBusy) return;
		this.updateBusy = "checking";
		this.updateNote = null;
		try {
			this.updateInfo = await new HubApi(url).updateStatus();
		} catch (err) {
			this.updateNote = { ok: false, text: (err as Error).message };
		} finally {
			this.updateBusy = null;
		}
	}

	private async applyUpdate(force = false): Promise<void> {
		const url = getHubUrl();
		if (!url || this.updateBusy) return;
		this.updateBusy = "updating";
		this.updateNote = null;
		const api = new HubApi(url);
		try {
			const r = await api.update(force);
			this.updateBusy = "restarting";
			this.updateNote = { ok: true, text: `Pulled ${r.commit}; the hub is restarting…` };
			const back = await this.waitForHub(api);
			this.updateInfo = null;
			this.updateNote = back ? { ok: true, text: `Hub back up at ${back.hubVersion} (${r.commit}).` } : { ok: false, text: `The hub pulled ${r.commit} but hasn't come back yet. Give it a moment, then connect again.` };
			if (back) toast("Hub updated.");
		} catch (err) {
			const e = err as Error & { status?: number };
			this.updateNote = { ok: false, text: e.message, force: e.status === 409 && !force && /mid-turn/.test(e.message) };
		} finally {
			this.updateBusy = null;
		}
	}

	// The hub exits after answering; poll until systemd has it listening again.
	private async waitForHub(api: HubApi) {
		await new Promise((r) => setTimeout(r, 1500));
		for (let i = 0; i < 40; i++) {
			try {
				return await api.health();
			} catch {
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		return null;
	}

	private renderUpdate() {
		if (!getHubUrl()) return html`<p class="hint">Connect to a hub first.</p>`;
		const u = this.updateInfo;
		const busy = this.updateBusy;
		const label = busy === "checking" ? "checking…" : busy === "updating" ? "updating…" : busy === "restarting" ? "restarting…" : u ? "check again" : "check for updates";
		return html`
			<div class="row">
				<button class="btn ghost" ?disabled=${Boolean(busy)} @click=${() => this.checkUpdate()}>${label}</button>
				${u?.behind ? html`<button class="btn" ?disabled=${Boolean(busy)} @click=${() => this.applyUpdate()}>update &amp; restart</button>` : nothing}
				${this.updateNote?.force ? html`<button class="btn" ?disabled=${Boolean(busy)} @click=${() => this.applyUpdate(true)}>update anyway</button>` : nothing}
			</div>
			${u
				? html`<p class="hint" role="status">
						hub ${u.version} at <code>${u.commit}</code>${u.dirty ? ", with local changes" : ""}.
						${u.fetchError ? html` Couldn't reach GitHub: ${u.fetchError}.` : u.behind ? html` ${u.behind} commit${u.behind === 1 ? "" : "s"} behind master; latest: <code>${u.latest}</code>.` : " Up to date with master."}
					</p>`
				: nothing}
			${this.updateNote ? html`<p class="status ${this.updateNote.ok ? "ok" : "bad"}" role="status">${this.updateNote.text}</p>` : nothing}
		`;
	}

	connectedCallback(): void {
		super.connectedCallback();
		void this.refreshPush();
		void this.loadHealth();
	}

	private async refreshPush(): Promise<void> {
		this.push = await pushStatus(browserPushEnv()).catch(() => "unsupported" as const);
	}

	private async setPush(on: boolean): Promise<void> {
		const url = getHubUrl();
		if (!url || this.pushBusy) return;
		this.pushBusy = true;
		this.pushError = null;
		try {
			const api = new HubApi(url);
			if (on) await enablePush(api, browserPushEnv());
			else await disablePush(api, browserPushEnv());
		} catch (err) {
			this.pushError = (err as Error).message;
		} finally {
			this.pushBusy = false;
			await this.refreshPush();
		}
	}

	private renderPush() {
		if (!getHubUrl()) return html`<p class="hint">${PUSH_COPY.noHub}</p>`;
		if (this.push === "install-first") return html`<p class="hint">${PUSH_COPY.installFirst}</p>`;
		if (this.push === "unsupported") return html`<p class="hint">${PUSH_COPY.unsupported}</p>`;
		if (this.push === "denied") return html`<p class="hint">${PUSH_COPY.denied}</p>`;
		if (this.push === null) return nothing;
		return html`<div class="seg" role="radiogroup" aria-label="Notifications">
				${(["off", "on"] as const).map(
					(v) => html`<button role="radio" aria-checked=${this.push === v ? "true" : "false"} class=${this.push === v ? "on" : ""} ?disabled=${this.pushBusy} @click=${() => this.setPush(v === "on")}>${v}</button>`,
				)}
			</div>
			${this.pushError ? html`<p class="status bad" role="status">${this.pushError}</p>` : nothing}`;
	}

	private async connect(e: Event): Promise<void> {
		e.preventDefault();
		let base: string;
		try {
			base = normalizeHubUrl(this.url);
		} catch (err) {
			this.status = { ok: false, text: (err as Error).message };
			return;
		}
		this.checking = true;
		try {
			const h = await new HubApi(base).health();
			setHubUrl(base);
			this.url = base;
			this.status = { ok: true, text: `Connected as ${h.login} (hub ${h.hubVersion}).` };
			this.dispatchEvent(new CustomEvent("pi-hub-changed", { bubbles: true, composed: true }));
			location.hash = "#/";
		} catch (err) {
			this.status = { ok: false, text: (err as Error).message };
		} finally {
			this.checking = false;
		}
	}

	render() {
		return html`<div class="wrap">
			<a class="back u" href="#/">← sessions</a>
			<h1>settings</h1>
			<form @submit=${this.connect}>
				<label for="hub">hub address</label>
				<p class="hint">The tailnet address of the pi-web hub on spark, for example <code>spark-713a.tail9274fa.ts.net:7878</code>.</p>
				<div class="row">
					<input id="hub" .value=${this.url} @input=${(e: Event) => (this.url = (e.target as HTMLInputElement).value)} placeholder="spark-713a.tail9274fa.ts.net:7878" autocomplete="off" autocapitalize="off" spellcheck="false" />
					<button class="btn" ?disabled=${this.checking}>${this.checking ? "checking…" : "connect"}</button>
				</div>
				${this.status ? html`<p class="status ${this.status.ok ? "ok" : "bad"}" role="status">${this.status.text}</p>` : nothing}
			</form>
			<h2>hub</h2>
			<p class="hint">Pull the latest master on spark, install, and restart the hub. A session mid-turn would be cut off, so the hub refuses while one is running unless you say so.</p>
			${this.renderUpdate()}
			<h2>theme</h2>
			<div class="seg" role="radiogroup" aria-label="Theme">
				${(["system", "light", "dark"] as const).map(
					(t) => html`<button role="radio" aria-checked=${this.theme === t ? "true" : "false"} class=${this.theme === t ? "on" : ""} @click=${() => {
						setTheme(t);
						this.theme = t;
					}}>${t}</button>`,
				)}
			</div>
			<h2>notifications</h2>
			<p class="hint">${PUSH_COPY.hint}</p>
			${this.renderPush()}
			<h2>watch</h2>
			${this.renderWatch()}
			<h2>display diagnostics</h2>
			<p class="hint">Temporary: shows the screen measurements on top of the app, for fixing the iPhone layout.</p>
			<div class="seg" role="radiogroup" aria-label="Display diagnostics">
				${(["off", "on"] as const).map(
					(v) => html`<button role="radio" aria-checked=${vpDebugOn() === (v === "on") ? "true" : "false"} class=${vpDebugOn() === (v === "on") ? "on" : ""} @click=${() => setVpDebug(v === "on")}>${v}</button>`,
				)}
			</div>
			<h2>install</h2>
			<p class="hint">On iPhone or iPad, open this page in Safari and choose Share → Add to Home Screen.</p>
		</div>`;
	}
}
customElements.define("pi-settings", PiSettings);
