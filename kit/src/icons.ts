import { html } from "lit";

// Lucide icons (ISC licence), inline so they follow currentColor.
const svg = (body: ReturnType<typeof html>) =>
	html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const X_ICON = svg(html`<path d="M18 6 6 18" /><path d="m6 6 12 12" />`);
export const MENU_ICON = svg(html`<path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" />`);
export const PANEL_LEFT_ICON = svg(html`<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" />`);
export const PANEL_RIGHT_ICON = svg(html`<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" />`);
