import { LitElement, css, html } from "lit";

// Two-column grid of tk-stat tiles; a [wide] tile spans both columns.
export class TkStats extends LitElement {
	static styles = css`
		:host { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
		::slotted(tk-stat[wide]) { grid-column: 1 / -1; }
	`;

	render() {
		return html`<slot></slot>`;
	}
}

customElements.define("tk-stats", TkStats);
