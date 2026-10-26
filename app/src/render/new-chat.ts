import { css, html } from "lit";
import { hrefFor } from "../lib/route.ts";

// Lucide icon (ISC): square-pen.
const NEW_CHAT_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></svg>`;

// The header's new-chat button, for a tk-header's actions slot on every screen.
export const newChatButton = () =>
	html`<button slot="actions" class="new" aria-label="New chat" @click=${() => (location.hash = hrefFor({ name: "new" }))}>${NEW_CHAT_ICON}</button>`;

export const newChatStyles = css`
	.new { display: grid; place-items: center; width: 32px; height: 32px; margin: -6px -6px -6px 0; color: var(--text-secondary); }
	.new svg { width: 20px; height: 20px; }
`;
