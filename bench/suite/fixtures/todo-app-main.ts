import { LitElement, html, css } from "https://kit.thatsit.app/lit.js";
import { sharedStyles } from "https://kit.thatsit.app/kit.js";
import { addItem, clearDone, counts, toggle, type Item } from "./todo.ts";

// A single-page to-do list on the kit. The bench's one-line and feature tasks start here.
export class AppMain extends LitElement {
	static properties = { items: { state: true }, draft: { state: true } };
	static styles = [
		sharedStyles,
		css`
			main { display: grid; gap: 14px; padding: 18px; max-width: 34rem; margin: 0 auto; }
			.row { display: flex; gap: 8px; align-items: center; }
			input { flex: 1; }
			ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
			li { display: flex; gap: 8px; align-items: center; }
			li.done .text { text-decoration: line-through; color: var(--text-muted); }
			.text { flex: 1; }
			.empty { color: var(--text-muted); }
		`,
	];

	items: Item[] = [];
	draft = "";
	#id = 1;

	#add() {
		this.items = addItem(this.items, this.draft, this.#id++);
		this.draft = "";
	}

	render() {
		const { done, total } = counts(this.items);
		return html`
			<main>
				<h1>${__APP_TITLE__}</h1>
				<div class="row">
					<input .value=${this.draft} @input=${(e: Event) => (this.draft = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.#add()} placeholder="Add a task" />
					<button class="btn add" @click=${() => this.#add()}>Add</button>
				</div>
				${total === 0
					? html`<p class="empty">Nothing yet</p>`
					: html`<ul>
							${this.items.map(
								(i) => html`<li class=${i.done ? "done" : ""}>
									<button class="switch" role="switch" aria-checked=${i.done} aria-label=${i.text} @click=${() => (this.items = toggle(this.items, i.id))}></button>
									<span class="text">${i.text}</span>
								</li>`,
							)}
						</ul>`}
				<div class="row">
					<span class="label">${done} of ${total} done</span>
					<button class="btn ghost" @click=${() => (this.items = clearDone(this.items))}>Clear done</button>
				</div>
			</main>
		`;
	}
}
customElements.define("app-main", AppMain);
