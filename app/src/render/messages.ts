import { type TemplateResult, css, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentMessage, ContentBlock, Conversation, ToolRun } from "../../../shared/src/protocol.ts";
import { blocksText, formatTokens, parseArgsRaw, summarizeToolArgs, truncateOutput, wordCount } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";

type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;
type Results = Map<string, AgentMessage>;

export function renderConversation(conv: Conversation): TemplateResult {
	const results: Results = new Map();
	for (const m of conv.messages) if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
	return html`${conv.messages.map((m) => renderMessage(m, results, conv.tools))}${conv.partial ? renderAssistant(conv.partial, results, conv.tools, true) : nothing}`;
}

function renderMessage(m: AgentMessage, results: Results, tools: Record<string, ToolRun>) {
	switch (m.role) {
		case "user":
			return renderUser(m);
		case "assistant":
			return renderAssistant(m, results, tools, false);
		case "bashExecution":
			return renderBash(m);
		case "compactionSummary":
			return html`<details class="marker"><summary>compacted · ${formatTokens(Number(m.tokensBefore ?? 0))} tokens summarized</summary><div class="md">${unsafeHTML(renderMarkdown(String(m.summary ?? "")))}</div></details>`;
		case "branchSummary":
			return html`<details class="marker"><summary>summary of another branch</summary><div class="md">${unsafeHTML(renderMarkdown(String(m.summary ?? "")))}</div></details>`;
		case "custom":
			return m.display === false ? nothing : html`<div class="custom"><span class="label">${String(m.customType ?? "extension")}</span> ${blocksText(m.content)}</div>`;
		default:
			return nothing; // toolResult renders inside its tool card; system is never shown
	}
}

function renderUser(m: AgentMessage) {
	const images = Array.isArray(m.content) ? m.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image") : [];
	return html`<div class="user">${blocksText(m.content)}${
		images.length ? html`<div class="imgs">${images.map((i) => html`<img alt="attached image" src="data:${i.mimeType};base64,${i.data}" />`)}</div>` : nothing
	}</div>`;
}

function renderAssistant(m: AgentMessage, results: Results, tools: Record<string, ToolRun>, streaming: boolean) {
	const blocks = Array.isArray(m.content) ? m.content : [];
	return html`<div class="assistant">
		${blocks.map((b) => {
			if (!b) return nothing;
			if (b.type === "thinking") {
				if (b.thinking.trim()) return html`<details class="think"><summary>thinking · ${wordCount(b.thinking)} words</summary><div class="think-body">${b.thinking}</div></details>`;
				return b.redacted ? html`<div class="note">thinking (redacted)</div>` : nothing;
			}
			if (b.type === "text") return b.text.trim() ? html`<div class="md">${unsafeHTML(renderMarkdown(b.text))}</div>` : nothing;
			if (b.type === "toolCall") return renderTool(b, results.get(b.id), tools[b.id]);
			return nothing;
		})}
		${m.stopReason === "error" ? html`<div class="err" role="alert">${String(m.errorMessage ?? "The model returned an error.")}</div>` : nothing}
		${m.stopReason === "aborted" ? html`<div class="note">stopped</div>` : nothing}
		${streaming && blocks.length === 0 ? html`<div class="note">working…</div>` : nothing}
	</div>`;
}

function renderTool(call: ToolCall, result?: AgentMessage, run?: ToolRun) {
	const args = call.arguments && Object.keys(call.arguments).length ? call.arguments : parseArgsRaw(call.argsRaw);
	const done = Boolean(result) || run?.running === false;
	const isError = result ? Boolean(result.isError) : Boolean(run?.isError);
	const status = !done ? "running" : isError ? "error" : "ok";
	const output = blocksText(result?.content ?? run?.result?.content ?? run?.partialResult?.content);
	return html`<details class="tool ${status}">
		<summary>
			<span class="st" aria-label=${status}>${status === "ok" ? "✓" : status === "error" ? "✗" : html`<span class="spin"></span>`}</span>
			<span class="name">${call.name}</span>
			<code>${summarizeToolArgs(call.name, args)}</code>
		</summary>
		${Object.keys(args).length ? html`<pre class="args">${JSON.stringify(args, null, 2)}</pre>` : nothing}
		${output ? html`<pre class="out">${truncateOutput(output)}</pre>` : nothing}
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
	.user { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; font-family: var(--font-quote); white-space: pre-wrap; overflow-wrap: anywhere; }
	.imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
	.imgs img { max-width: 160px; max-height: 160px; border-radius: var(--radius); }
	.assistant { display: grid; gap: 8px; min-width: 0; }
	.md { overflow-wrap: anywhere; line-height: 1.6; min-width: 0; }
	.md > :first-child { margin-top: 0; }
	.md > :last-child { margin-bottom: 0; }
	.md p, .md ul, .md ol { margin: 0 0 0.7em; }
	.md h1, .md h2, .md h3, .md h4 { font-family: var(--font-display); font-weight: 600; line-height: 1.25; margin: 1em 0 0.4em; font-size: 1.1em; }
	.md pre { background: var(--code-bg); padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85em; }
	.md code { font-family: var(--font-mono); font-size: 0.9em; background: var(--code-bg); padding: 1px 4px; border-radius: 2px; }
	.md pre code { background: none; padding: 0; }
	.md blockquote { border-left: 3px solid var(--line); margin: 0 0 0.7em; padding-left: 12px; color: var(--text-2); }
	.md table { border-collapse: collapse; display: block; overflow-x: auto; margin-bottom: 0.7em; }
	.md th, .md td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
	details > summary { cursor: pointer; list-style: none; }
	details > summary::-webkit-details-marker { display: none; }
	.think summary { font-size: 0.82em; color: var(--muted); font-style: italic; }
	.think-body { white-space: pre-wrap; font-size: 0.85em; color: var(--text-2); border-left: 2px solid var(--line); padding-left: 10px; margin-top: 4px; }
	.tool { border: 1px solid var(--line); border-radius: var(--radius); font-size: 0.82em; min-width: 0; }
	.tool summary { display: flex; gap: 8px; align-items: center; padding: 5px 9px; background: var(--panel); min-width: 0; }
	.tool .name { font-weight: 600; flex: none; }
	.tool code { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; color: var(--text-2); }
	.tool.ok .st { color: var(--success); font-weight: 700; }
	.tool.error .st { color: var(--primary); font-weight: 700; }
	.tool pre { margin: 0; padding: 8px 9px; font-family: var(--font-mono); font-size: 0.92em; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; color: var(--text-2); }
	.tool pre.args { border-bottom: 1px solid var(--line); }
	.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--line); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -1px; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.err { color: var(--primary); font-size: 0.9em; border-left: 3px solid var(--primary); padding-left: 10px; overflow-wrap: anywhere; }
	.note { font-size: 0.8em; color: var(--muted); font-style: italic; }
	.marker { border-top: 1px dashed var(--line); padding-top: 6px; }
	.marker summary, .custom { font-size: 0.8em; color: var(--muted); }
	.marker summary { font-family: var(--font-display); letter-spacing: 0.06em; }
`;
