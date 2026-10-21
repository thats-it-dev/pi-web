import { type TemplateResult, css, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentMessage, ContentBlock, Conversation, ToolRun } from "../../../shared/src/protocol.ts";
import { blocksText, formatTokens, parseArgsRaw, summarizeToolArgs, truncateOutput, wordCount } from "../lib/format.ts";
import type { ImageLoader } from "../lib/image-loader.ts";
import { renderMarkdown, renderMarkdownUncached } from "../lib/markdown.ts";

type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;
type Results = Map<string, AgentMessage>;
type ImageContent = Extract<ContentBlock, { type: "image" }>;

// The whole conversation re-renders on every streaming delta, so work on
// completed messages is memoized per object: they are never mutated once they
// land in conv.messages (and tool runs are replaced, not mutated). The
// streaming partial is mutated in place, so it is never memoized.
const memos = new WeakMap<object, Map<string, unknown>>();
function memo<T>(key: object, slot: string, compute: () => T): T {
	let m = memos.get(key);
	if (!m) memos.set(key, (m = new Map()));
	if (!m.has(slot)) m.set(slot, compute());
	return m.get(slot) as T;
}

function markdown(text: string, key: object | null) {
	return unsafeHTML(key ? memo(key, "md", () => renderMarkdown(text)) : renderMarkdownUncached(text));
}

function imagesOf(content: unknown): ImageContent[] {
	return Array.isArray(content) ? content.filter((b): b is ImageContent => Boolean(b) && b.type === "image") : [];
}

function thumbs(images: ImageContent[], loader: ImageLoader | null, alt: string) {
	return images.map((i) => html`<pi-image .block=${i} .loader=${loader} .alt=${alt} .variant=${"thumb"}></pi-image>`);
}

export function renderConversation(conv: Conversation, loader: ImageLoader | null = null): TemplateResult {
	const results: Results = new Map();
	for (const m of conv.messages) if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
	return html`${conv.messages.map((m) => renderMessage(m, results, conv.tools, loader))}${conv.partial ? renderAssistant(conv.partial, results, conv.tools, true, loader) : nothing}`;
}

function renderMessage(m: AgentMessage, results: Results, tools: Record<string, ToolRun>, loader: ImageLoader | null) {
	switch (m.role) {
		case "user":
			return renderUser(m, loader);
		case "assistant":
			return renderAssistant(m, results, tools, false, loader);
		case "bashExecution":
			return renderBash(m);
		case "compactionSummary":
			return html`<details class="marker"><summary>compacted · ${formatTokens(Number(m.tokensBefore ?? 0))} tokens summarized</summary><div class="md">${markdown(String(m.summary ?? ""), m)}</div></details>`;
		case "branchSummary":
			return html`<details class="marker"><summary>summary of another branch</summary><div class="md">${markdown(String(m.summary ?? ""), m)}</div></details>`;
		case "custom":
			return m.display === false ? nothing : html`<div class="custom"><span class="label">${String(m.customType ?? "extension")}</span> ${blocksText(m.content)}</div>`;
		default:
			return nothing; // toolResult renders inside its tool card; system is never shown
	}
}

function renderUser(m: AgentMessage, loader: ImageLoader | null) {
	const images = imagesOf(m.content);
	return html`<div class="user">${blocksText(m.content)}${
		images.length ? html`<div class="imgs">${thumbs(images, loader, "attached image")}</div>` : nothing
	}</div>`;
}

function renderAssistant(m: AgentMessage, results: Results, tools: Record<string, ToolRun>, streaming: boolean, loader: ImageLoader | null) {
	const blocks = Array.isArray(m.content) ? m.content : [];
	return html`<div class="assistant">
		${blocks.map((b) => {
			if (!b) return nothing;
			if (b.type === "thinking") {
				const thinking = String(b.thinking ?? "");
				if (thinking.trim()) {
					const words = streaming ? wordCount(thinking) : memo(b, "words", () => wordCount(thinking));
					return html`<details class="think"><summary>thinking · ${words} words</summary><div class="think-body">${thinking}</div></details>`;
				}
				return b.redacted ? html`<div class="note">thinking (redacted)</div>` : nothing;
			}
			if (b.type === "text") {
				const text = String(b.text ?? "");
				return text.trim() ? html`<div class="md">${markdown(text, streaming ? null : b)}</div>` : nothing;
			}
			if (b.type === "toolCall") return renderTool(b, results.get(b.id), tools[b.id], streaming, loader);
			return nothing;
		})}
		${m.stopReason === "error" ? html`<div class="err" role="alert">${String(m.errorMessage ?? "The model returned an error.")}</div>` : nothing}
		${m.stopReason === "aborted" ? html`<div class="note">stopped</div>` : nothing}
		${streaming && blocks.length === 0 ? html`<div class="note">working…</div>` : nothing}
	</div>`;
}

function toolArgs(call: ToolCall): { summary: string; json: string } {
	const args = call.arguments && Object.keys(call.arguments).length ? call.arguments : parseArgsRaw(call.argsRaw);
	return { summary: summarizeToolArgs(call.name, args), json: Object.keys(args).length ? JSON.stringify(args, null, 2) : "" };
}

// A finished show_image call is a figure in the flow, not a collapsed card.
function renderShowImage(call: ToolCall, image: ImageContent, loader: ImageLoader | null) {
	const args = call.arguments && Object.keys(call.arguments).length ? call.arguments : parseArgsRaw(call.argsRaw);
	const caption = typeof args.caption === "string" ? args.caption.trim() : "";
	const path = typeof args.path === "string" ? args.path : "";
	return html`<figure class="shot">
		<pi-image .block=${image} .loader=${loader} .alt=${caption || path || "image"} .variant=${"figure"}></pi-image>
		${caption ? html`<figcaption>${caption}</figcaption>` : nothing}
		<div class="shot-tool">show_image · ${path}</div>
	</figure>`;
}

function renderTool(call: ToolCall, result: AgentMessage | undefined, run: ToolRun | undefined, streaming: boolean, loader: ImageLoader | null) {
	const done = Boolean(result) || run?.running === false;
	const isError = result ? Boolean(result.isError) : Boolean(run?.isError);
	const content = result?.content ?? run?.result?.content;
	if (call.name === "show_image" && done && !isError) {
		const details = (result?.details ?? run?.result?.details) as { image?: ImageContent } | undefined;
		const image = imagesOf(content)[0] ?? (details?.image && details.image.type === "image" ? details.image : undefined);
		if (image) return renderShowImage(call, image, loader);
	}
	const args = streaming ? toolArgs(call) : memo(call, "args", () => toolArgs(call));
	const status = !done ? "running" : isError ? "error" : "ok";
	const source = result ?? run;
	const output = source ? memo(source, "out", () => truncateOutput(blocksText(result?.content ?? run?.result?.content ?? run?.partialResult?.content))) : "";
	const images = imagesOf(content);
	return html`<details class="tool ${status}">
		<summary>
			<span class="st" aria-label=${status}>${status === "ok" ? "✓" : status === "error" ? "✗" : html`<span class="spin"></span>`}</span>
			<span class="name">${call.name}</span>
			<code>${args.summary}</code>
		</summary>
		${args.json ? html`<pre class="args">${args.json}</pre>` : nothing}
		${output ? html`<pre class="out">${output}</pre>` : nothing}
		${images.length ? html`<div class="imgs thumbs">${thumbs(images, loader, `image from ${call.name}`)}</div>` : nothing}
	</details>`;
}

function renderBash(m: AgentMessage) {
	const ok = m.exitCode === 0;
	return html`<details class="tool ${ok ? "ok" : "error"}">
		<summary><span class="st">$</span><code>${String(m.command ?? "")}</code>${m.excludeFromContext ? html`<span class="label">not in context</span>` : nothing}</summary>
		<pre class="out">${truncateOutput(String(m.output ?? ""))}</pre>
	</details>`;
}

export const messageStyles = css`
	:host { display: grid; gap: 14px; padding: 16px 18px 28px; max-width: 760px; margin: 0 auto; width: 100%; align-content: start; }
	.user { justify-self: end; max-width: 85%; border-right: 3px solid var(--primary); padding: 2px 12px 2px 0; font-family: var(--font-quote); white-space: pre-wrap; overflow-wrap: anywhere; }
	.imgs { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; margin-top: 6px; }
	.imgs.thumbs { justify-content: flex-start; padding: 0 9px 8px; }
	.shot { margin: 0; display: grid; gap: 4px; min-width: 0; justify-items: start; }
	.shot pi-image { max-width: 100%; max-height: 70vh; }
	.shot figcaption { color: var(--text-secondary); line-height: 1.4; overflow-wrap: anywhere; }
	.shot-tool { font-size: 0.82em; color: var(--text-muted); font-family: var(--font-mono); overflow-wrap: anywhere; }
	.assistant { display: grid; gap: 8px; min-width: 0; }
	.md { overflow-wrap: anywhere; line-height: 1.6; min-width: 0; }
	.md > :first-child { margin-top: 0; }
	.md > :last-child { margin-bottom: 0; }
	.md p, .md ul, .md ol { margin: 0 0 0.7em; }
	.md h1, .md h2, .md h3, .md h4 { font-family: var(--font-display); font-weight: 600; line-height: 1.25; margin: 1em 0 0.4em; font-size: 1.1em; }
	.md pre { background: var(--code-bg); padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85em; }
	.md code { font-family: var(--font-mono); font-size: 0.9em; background: var(--code-bg); padding: 1px 4px; border-radius: 2px; }
	.md pre code { background: none; padding: 0; }
	.md blockquote { border-left: 3px solid var(--line); margin: 0 0 0.7em; padding-left: 12px; color: var(--text-secondary); }
	.md table { border-collapse: collapse; display: block; overflow-x: auto; margin-bottom: 0.7em; }
	.md th, .md td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
	details > summary { cursor: pointer; list-style: none; }
	details > summary::-webkit-details-marker { display: none; }
	.think summary { font-size: 0.82em; color: var(--text-muted); font-style: italic; }
	.think-body { white-space: pre-wrap; font-size: 0.85em; color: var(--text-secondary); border-left: 2px solid var(--line); padding-left: 10px; margin-top: 4px; }
	.tool { border: 1px solid var(--line); border-radius: var(--radius); font-size: 0.82em; min-width: 0; }
	.tool summary { display: flex; gap: 8px; align-items: center; padding: 5px 9px; background: var(--panel); min-width: 0; }
	.tool .name { font-weight: 600; flex: none; }
	.tool code { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; color: var(--text-secondary); }
	.tool.ok .st { color: var(--success); font-weight: 700; }
	.tool.error .st { color: var(--accent); font-weight: 700; }
	.tool pre { margin: 0; padding: 8px 9px; font-family: var(--font-mono); font-size: 0.92em; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; color: var(--text-secondary); }
	.tool pre.args { border-bottom: 1px solid var(--line); }
	.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -1px; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.err { color: var(--accent); font-size: 0.9em; border-left: 3px solid var(--accent); padding-left: 10px; overflow-wrap: anywhere; }
	.note { font-size: 0.8em; color: var(--text-muted); font-style: italic; }
	.marker { border-top: 1px dashed var(--line); padding-top: 6px; }
	.marker summary, .custom { font-size: 0.8em; color: var(--text-muted); }
	.marker summary { font-family: var(--font-display); letter-spacing: 0.06em; }
`;
