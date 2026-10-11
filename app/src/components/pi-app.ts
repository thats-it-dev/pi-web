import { LitElement, css, html } from "lit";
import { sharedStyles } from "../styles/shared.ts";

export class PiApp extends LitElement {
	static styles = [sharedStyles, css`:host { display: grid; place-items: center; height: 100%; } h1 { font-family: var(--font-display); font-weight: 400; letter-spacing: 0.1em; font-size: 3rem; }`];
	render() {
		return html`<h1><span class="u on">pi</span></h1>`;
	}
}
customElements.define("pi-app", PiApp);
