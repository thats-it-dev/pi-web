// TEMPORARY: on-screen viewport readout for chasing the iOS home-screen layout
// gap. Switched on from Settings; remove once the layout is fixed.

const KEY = "pi-web:vp-debug";

export function vpDebugOn(): boolean {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

export function setVpDebug(on: boolean): void {
	try {
		if (on) localStorage.setItem(KEY, "1");
		else localStorage.removeItem(KEY);
	} catch {}
	location.reload();
}

function deep(root: Document | ShadowRoot, tag: string): Element | null {
	const hit = root.querySelector(tag);
	if (hit) return hit;
	for (const el of root.querySelectorAll("*")) {
		if (el.shadowRoot) {
			const inner = deep(el.shadowRoot, tag);
			if (inner) return inner;
		}
	}
	return null;
}

function probe(css: string): HTMLDivElement {
	const d = document.createElement("div");
	d.style.cssText = `position:fixed;left:-9999px;top:0;width:1px;visibility:hidden;pointer-events:none;${css}`;
	document.body.append(d);
	return d;
}

export function startVpDebug(): void {
	if (!vpDebugOn()) return;
	const units = ["100vh", "100dvh", "100svh", "100lvh", "100%"].map((u) => [u, probe(`height:${u}`)] as const);
	const safe = probe("padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);height:0");
	const box = document.createElement("pre");
	box.style.cssText =
		"position:fixed;left:8px;top:30%;z-index:9999;margin:0;padding:6px 8px;font:11px/1.35 ui-monospace,monospace;background:rgba(0,0,0,.78);color:#0f0;pointer-events:none;white-space:pre;border-radius:4px";
	document.body.append(box);
	const r = (el: Element | null) => {
		if (!el) return "—";
		const b = el.getBoundingClientRect();
		return `top ${Math.round(b.top)} bottom ${Math.round(b.bottom)} h ${Math.round(b.height)}`;
	};
	const update = () => {
		const vv = window.visualViewport;
		const cs = getComputedStyle(safe);
		const root = document.documentElement;
		const app = document.querySelector("pi-app");
		for (const [tag, color] of [["pi-header", "lime"], ["pi-composer", "cyan"]] as const) {
			const el = deep(document, tag) as HTMLElement | null;
			if (el) el.style.outline = `2px dashed ${color}`;
		}
		if (app) (app as HTMLElement).style.outline = "2px dashed red";
		box.textContent = [
			`standalone ${matchMedia("(display-mode: standalone)").matches} kb ${root.hasAttribute("data-keyboard")}`,
			`screen ${screen.width}x${screen.height} dpr ${devicePixelRatio}`,
			`inner ${innerWidth}x${innerHeight} outer ${outerWidth}x${outerHeight}`,
			`client ${root.clientWidth}x${root.clientHeight}`,
			`vv h ${vv?.height.toFixed(1)} top ${vv?.offsetTop.toFixed(1)} pageTop ${vv?.pageTop.toFixed(1)} s ${vv?.scale.toFixed(2)}`,
			`scrollY ${scrollY} body.scrollTop ${document.body.scrollTop}`,
			`safe t ${cs.paddingTop} b ${cs.paddingBottom} l ${cs.paddingLeft} r ${cs.paddingRight}`,
			units.map(([u, d]) => `${u} ${d.getBoundingClientRect().height}`).join("  "),
			`lvh-inner ${Math.round(units[3][1].getBoundingClientRect().height - innerHeight)}  --app-h ${root.style.getPropertyValue("--app-h") || "unset"} --app-top ${root.style.getPropertyValue("--app-top") || "unset"}`,
			`app    ${r(app)}  (red)`,
			`header ${r(deep(document, "pi-header"))}  (green)`,
			`compos ${r(deep(document, "pi-composer"))}  (cyan)`,
			`html   ${r(root)}  body ${r(document.body)}`,
		].join("\n");
	};
	window.visualViewport?.addEventListener("resize", update);
	window.visualViewport?.addEventListener("scroll", update);
	addEventListener("resize", update);
	setInterval(update, 500);
	update();
}
