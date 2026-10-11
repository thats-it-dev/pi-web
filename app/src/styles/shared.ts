import { css } from "lit";

// Small vocabulary shared by every component (shadow DOM doesn't inherit page CSS).
export const sharedStyles = css`
	:host { box-sizing: border-box; }
	*, *::before, *::after { box-sizing: inherit; }
	a { color: var(--accent); text-decoration: none; }
	button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
	input, textarea, select {
		font: inherit;
		font-size: 16px; /* stops iOS zooming on focus */
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 7px 10px;
	}
	:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.u { position: relative; }
	.u::after { content: ""; position: absolute; left: 0; bottom: -3px; height: 2px; width: 0; background: var(--accent); transition: width 0.2s ease-out; }
	.u:hover::after, .u.on::after { width: 100%; }
	.btn {
		display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		background: var(--primary); color: #fff;
		border: 1px solid var(--primary); border-radius: var(--radius);
		padding: 6px 12px; font-weight: 500; font-size: 0.9rem; line-height: 1.2;
	}
	.btn:disabled { opacity: 0.45; cursor: default; }
	.btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
	.label { font-family: var(--font-display); letter-spacing: 0.12em; text-transform: lowercase; color: var(--muted); font-size: 0.75rem; }
	.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
	.dot.live { background: var(--accent); }
	.dot.running { background: var(--primary); animation: pulse 1.4s ease-in-out infinite; }
	.dot.needs_you { background: var(--primary); }
	.dot.error { background: transparent; box-shadow: inset 0 0 0 2px var(--primary); }
	@keyframes pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary), transparent 70%); } }
	.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; width: max-content; }
	.seg button { padding: 5px 14px; font-size: 0.9rem; }
	.seg button.on { background: var(--text); color: var(--bg); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
