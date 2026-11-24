import { type TemplateResult, css, html } from "lit";
import { CODE_ICON, MESSAGE_CIRCLE_ICON } from "@thatsit/kit";
import type { SessionType } from "../../../shared/src/protocol.ts";

export function sessionTypeToggle(type: SessionType, onPick: (t: SessionType) => void): TemplateResult {
	return html`<span class="type-toggle ${type}" role="group" aria-label="Session type">
		<button type="button" aria-label="Code sessions" aria-pressed="${type === "code" ? "true" : "false"}" @click=${() => onPick("code")}>${CODE_ICON}</button>
		<button type="button" aria-label="Chat sessions" aria-pressed="${type === "chat" ? "true" : "false"}" @click=${() => onPick("chat")}>${MESSAGE_CIRCLE_ICON}</button>
	</span>`;
}

export const sessionTypeToggleStyles = css`
	.type-toggle { position: relative; display: inline-grid; grid-template-columns: 32px 32px; height: 28px; border: 1px solid var(--border-color); border-radius: var(--radius); overflow: hidden; }
	.type-toggle::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 32px; background: var(--primary); transition: transform 0.22s ease; }
	.type-toggle.chat::before { transform: translateX(32px); }
	.type-toggle button { position: relative; display: flex; align-items: center; justify-content: center; padding: 0; border: 0; background: none; color: var(--text-muted); cursor: pointer; transition: color 0.22s ease; }
	.type-toggle button[aria-pressed="true"] { color: #000; } /* as the kit's .btn on --primary: --bg is unreadable on amber in light */
	.type-toggle button:focus-visible { outline-offset: -2px; outline-color: var(--text-primary); } /* the container's overflow clips an outside ring */
	.type-toggle svg { width: 15px; height: 15px; }
	@media (pointer: coarse) {
		.type-toggle { grid-template-columns: 40px 40px; height: 32px; }
		.type-toggle::before { width: 40px; }
		.type-toggle.chat::before { transform: translateX(40px); }
	}
	@media (prefers-reduced-motion: reduce) { .type-toggle::before, .type-toggle button { transition: none; } }
`;
