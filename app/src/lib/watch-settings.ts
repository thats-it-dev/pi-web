import type { HealthInfo } from "../../../shared/src/protocol.ts";

// What the settings "watch" section shows; pure so it can be tested without a DOM.
export function watchSectionCopy(h: HealthInfo | null): { token: string | null; secret: string | null; hint: string } {
	if (h?.watch) {
		return {
			token: h.watch.token,
			secret: h.watch.indexSecret,
			hint: "Enter the token in the Pebble face and app settings, and the secret in the Index app's webhook settings (Sign requests). Mute pi-web in the Pebble app's notifications so requests don't arrive twice.",
		};
	}
	return { token: null, secret: null, hint: "This hub predates watch support; update it." };
}
