import { LitElement, nothing } from "lit";
import { sharedStyles } from "@thatsit/kit";
import type { Conversation } from "../../../shared/src/protocol.ts";
import type { ImageLoader } from "../lib/image-loader.ts";
import "./pi-image.ts";
import { messageStyles, renderConversation } from "../render/messages.ts";

export class PiMessages extends LitElement {
	static properties = { conv: { attribute: false }, version: { attribute: false }, loader: { attribute: false } };
	declare loader: ImageLoader | null;
	declare conv: Conversation | null;
	declare version: number; // bumped by the parent because conv is mutated in place
	static styles = [sharedStyles, messageStyles];

	constructor() {
		super();
		this.conv = null;
		this.version = 0;
		this.loader = null;
	}

	render() {
		return this.conv ? renderConversation(this.conv, this.loader) : nothing;
	}
}
customElements.define("pi-messages", PiMessages);
