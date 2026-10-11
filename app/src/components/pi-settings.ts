import { LitElement, css, html, nothing } from "lit";
import { HubApi } from "../lib/api.ts";
import { type ThemePref, getHubUrl, getTheme, normalizeHubUrl, setHubUrl, setTheme } from "../lib/settings.ts";
import { sharedStyles } from "../styles/shared.ts";

export class PiSettings extends LitElement {
	static properties = { url: { state: true }, status: { state: true }, checking: { state: true }, theme: { state: true } };
	declare url: string;
	declare status: { ok: boolean; text: string } | null;
	declare checking: boolean;
	declare theme: ThemePref;

	static styles = [
		sharedStyles,
		css`
			:host { display: block; overflow-y: auto; height: 100%; }
			.wrap { max-width: 560px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top)) 18px 40px; display: grid; gap: 14px; }
			h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 2rem; margin: 0; }
			h2 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.08em; font-size: 1.2rem; margin: 18px 0 0; }
			label { font-family: var(--font-display); letter-spacing: 0.06em; }
			.hint { color: var(--text-2); font-size: 0.85rem; margin: 0; }
			code { font-family: var(--font-mono); font-size: 0.85em; }
			form { display: grid; gap: 8px; }
			.row { display: flex; gap: 8px; }
			.row input { flex: 1; min-width: 0; }
			.status.ok { color: var(--success); }
			.status.bad { color: var(--primary); }
			a.back { font-family: var(--font-quote); }
		`,
	];

	constructor() {
		super();
		this.url = getHubUrl() ?? "";
		this.status = null;
		this.checking = false;
		this.theme = getTheme();
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
			<h2>theme</h2>
			<div class="seg" role="radiogroup" aria-label="Theme">
				${(["system", "light", "dark"] as const).map(
					(t) => html`<button role="radio" aria-checked=${this.theme === t ? "true" : "false"} class=${this.theme === t ? "on" : ""} @click=${() => {
						setTheme(t);
						this.theme = t;
					}}>${t}</button>`,
				)}
			</div>
			<h2>install</h2>
			<p class="hint">On iPhone or iPad, open this page in Safari and choose Share → Add to Home Screen.</p>
		</div>`;
	}
}
customElements.define("pi-settings", PiSettings);
