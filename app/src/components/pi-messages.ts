import { LitElement, nothing } from "lit";
import type { Conversation } from "../../../shared/src/protocol.ts";
import { messageStyles, renderConversation } from "../render/messages.ts";
import { sharedStyles } from "../styles/shared.ts";

export class PiMessages extends LitElement {
	static properties = { conv: { attribute: false }, version: { attribute: false } };
	declare conv: Conversation | null;
	declare version: number; // bumped by the parent because conv is mutated in place
	static styles = [sharedStyles, messageStyles];

	constructor() {
		super();
		this.conv = null;
		this.version = 0;
	}

	render() {
		return this.conv ? renderConversation(this.conv) : nothing;
	}
}
customElements.define("pi-messages", PiMessages);
