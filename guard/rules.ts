// Pure rules for the guard extension. index.ts wires them to pi's events.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Block = { block: true; reason: string };

const SKILL_CLI = "node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts";

export const REASONS = {
	push: `Blocked: in an app, never push yourself. Commit, then run \`${SKILL_CLI} pr <dir> ...\`; it pushes and opens the PR. Then wait for CI: run \`${SKILL_CLI} pr-wait <dir>\` with the bg_bash tool. For the first version, run \`ship\` with the bg_bash tool instead.`,
	ci: `Blocked: don't wait for or poll CI yourself (no sleep, gh run list/watch/view, gh pr checks). Wait with \`pr-wait\`, \`gateway-pr-wait\` or \`ship\` through the bg_bash tool; it prints the failing log lines. After a fix commit, rerun the same \`pr\` command, then \`pr-wait\` with bg_bash.`,
	e2e: "Blocked: the full e2e suite runs only before a commit, through `npm run verify`. While iterating, run one spec: `npm run e2e:one -- e2e/<file>.spec.ts`.",
	rewrite: "Blocked: don't rewrite files with a Python script. Use the edit tool (read the lines first); it checks the edit and tells you when the old text doesn't match.",
	prTimeout: "Blocked: `pr` and `gateway-pr` return as soon as the PR is open. Run the same command again with no timeout.",
	waitInBackground: "Blocked: `pr-wait`, `gateway-pr-wait` and `ship` wait on CI. Run the same command with the bg_bash tool, tell Michael the PR link, then end your turn; a bg-bash-done message wakes you when CI finishes.",
	review: `Blocked: run the reviewer before opening the PR. A design doc or plan under docs/superpowers gets a review too (the guard briefs the reviewer for it; no verify needed for a docs-only change). Run \`npm run verify\` in the app if you edited code since it last passed, then call the \`subagent\` tool (call \`subagents_enable\` first if it is not available) with agent "reviewer" and a task that names Michael's request and \`docs/spec.md\` (and, if the app generates content or changes with the user's progress, a file sampling output at the first, a middle and the last stage). The guard writes the diff and the review scope itself; don't write a diff. A review that ended without a \`## Review\` block or \`No issues found.\` doesn't count: call the reviewer again. Fix what you confirm, rerun \`npm run verify\`, commit, list the findings you fixed and rejected in the PR body, then rerun this command.`,
	reviewUnverified: "Blocked: run `npm run verify` in the app first, and call the reviewer once it passes. Edits to code since the last green verify make the review stale; edits to docs and Markdown don't.",
	reviewWorkflow: 'Blocked: in an app, call the reviewer directly: the `subagent` tool with agent "reviewer" and a task, not inside a workflow, chain or task list. The guard scopes a direct call to the diff.',
	reviewNothing: "Blocked: nothing changed in the app since the last review, so there is nothing to review. Go on with the next step (commit, then the skill's `pr` command).",
	reviewBlockedSame:
		"Blocked: the last review of this exact tree ended with the merge verdict BLOCK, and a second opinion on the same code is not a review. Send its P0 and P1 findings to the worker, run `npm run verify`, commit, then call the reviewer again: the next review covers the change and the fix together. If you are sure a finding is wrong, don't argue it with the reviewer: tell Michael which finding and why, and end your turn. The PR gate stays shut until he says.",
	screen: `Blocked: look at the screen first. Run \`${SKILL_CLI} screenshot <dir>\` in bash (a phone-size dark picture of the app as it is now; \`--path /route\` for another screen, \`--scheme light\` for light, \`--upload <file>\` to load a file Michael's request names, so the picture shows his data and not the shipped content). The picture comes back in the result together with docs/spec.md and the pictures Michael sent: compare them and write down what differs. Missing colours, borders or fills, a shifted grid, overlapping labels, a control that is gone, a side or an order the spec states differently, mean the change is wrong even though verify is green: send it back to the worker with the picture's path, then verify and look again. When nothing differs, go on to the review (or to ship for a first version).`,
	overwrite: `Blocked: this rewrites a long existing file. Every line you write costs generation time, so change it with the edit tool: oldText is the fewest unique lines that locate the change (usually 1-3), and newText repeats as few unchanged lines as possible. If you really mean to replace most of the file, send the same write again and it will go through.`,
	discard: "Blocked: this would throw away uncommitted changes in the app. To show a test fails, write the test first and run it before the fix; never revert source to prove it red. To see an older version, use `git show <ref>:<path>`. To set work aside, commit it first.",
	worktreeInstall:
		"Blocked: a pi-subagents worktree shares the main checkout's node_modules through a symlink, so `npm ci` or `npm install` here deletes the packages of the main checkout and of every other worktree. The packages are already installed: run typecheck and tests straight away. If a dependency really must change, say so in your result and let the orchestrator do it in the main checkout.",
	orchestrator:
		"Blocked: you are the orchestrator of the agent pair; you never edit, write or delete app code yourself. Your files are the plan, the ledger and the briefs. A failing verify, e2e or review finding goes back to a worker: resume the worker (`subagent` with `action: \"resume\"` and the failing output) or dispatch a fresh one with a brief that names the failure. Commits and `npm run verify` in the main checkout are yours; the pull request is Michael's to merge.",
	merge: "Blocked: never merge or close a pull request; Michael merges. Green CI means your work is done: reply with the PR link and the preview link, say CI is green, and end your turn. Don't suggest a merge command either.",
	reviewRepo:
		'Blocked: run the reviewer before opening the PR or pushing this branch. A git repo under ~/workspace gets the same review gate as an app: call the `subagent` tool (call `subagents_enable` first if it is not available) with agent "reviewer", `cwd` set to the repo, and a task that names Michael\'s request. The guard writes the diff against main and the review scope itself; don\'t write a diff. If the repo has `npm run verify`, run it green first. A review that ended without a `## Review` block or `No issues found.` doesn\'t count: call the reviewer again. Fix what you confirm, commit, list the findings you fixed and rejected in the PR body, then rerun this command.',
};

// Merging or closing a PR by the gh CLI or the REST API (a push to main in an app is the push rule's). Michael merges (SKILL.md step 7),
// and on 2026-11-16 the orchestrator, having never read the skill, merged keeb #28 with `gh pr merge` the moment CI was green.
const MERGES = /\bgh\s+pr\s+(?:merge|close)\b|\bgh\s+api\b[^;&|\n]*(?:\/merge\b|-X\s*PUT\b[^;&|\n]*\/pulls\/|--method[\s=]*PUT\b[^;&|\n]*\/pulls\/)/;

/** A shell command that merges or closes a pull request. */
export function merges(command: string): boolean {
	return command.split(/;|&&|\|\||\n/).some((seg) => MERGES.test(seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')));
}

/** A worker launched without `worktree: true` owns the app's main checkout until its run ends: a verify or e2e run
 *  beside it shares the e2e server port and test-results, and tests half-edited files. */
export const workerBusy = (runId: string) =>
	`Blocked: worker ${runId.slice(0, 8)} is still working in this app's main checkout. Its verify and yours would share the e2e server port and test-results, and would test half-edited files. Wait for its result (a message arrives when the run ends; \`subagent\` with action "status" shows progress), then run \`npm run verify\` once. A worker that must run beside you goes in a worktree (\`worktree: true\`).`;

// The app a command works in: from a path to ~/workspace/apps/<name> in the command, else the session cwd.
export function appDir(command: string, cwd: string, home: string): string | undefined {
	const apps = join(home, "workspace", "apps");
	const expanded = command.replace(/(^|[\s="'(])(~|\$HOME|\$\{HOME\})(?=\/)/g, `$1${home}`);
	const at = expanded.indexOf(`${apps}/`);
	if (at >= 0) {
		const name = appName(expanded.slice(at + apps.length + 1));
		if (name) return join(apps, name);
	}
	if (cwd.startsWith(`${apps}/`)) {
		const name = appName(cwd.slice(apps.length + 1));
		if (name) return join(apps, name);
	}
	return undefined;
}

// The app in a path relative to ~/workspace/apps: its first segment, or the second under `worktrees/`
// (pi-subagents cuts worktrees at ~/workspace/apps/worktrees/<app>/pi-worktree-<run>-<i>).
// A trailing dot is the sentence's, not the name's ("…in /home/m/workspace/apps/keeb." made a dir that does not exist).
function appName(rel: string): string | undefined {
	const m = /^([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/.exec(rel);
	if (!m) return undefined;
	const name = (m[1] === "worktrees" ? m[2] : m[1])?.replace(/\.+$/, "");
	return name || undefined;
}

/** A path under ~/workspace that is not an app: the first one in the text (trailing punctuation dropped), else the cwd
 *  when it is such a path. What the review gate scopes a repo by; its git root is `Env.repoRoot`'s (index.ts), since
 *  the path may be a worktree or a file that does not exist yet. */
export function workspacePath(text: string, cwd: string, home: string): string | undefined {
	const ws = join(home, "workspace");
	const apps = `${join(ws, "apps")}/`;
	const expanded = text.replace(/(^|[\s="'(])(~|\$HOME|\$\{HOME\})(?=\/)/g, `$1${home}`);
	const escaped = ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const m of expanded.matchAll(new RegExp(`${escaped}/[^\\s"'()]+`, "g"))) {
		const path = m[0].replace(/[.,;:!?]+$/, "");
		if (!path.startsWith(apps)) return path;
	}
	return cwd.startsWith(`${ws}/`) && !cwd.startsWith(apps) ? cwd : undefined;
}

/** pi's settings put the agent pair in charge: the pair orchestrator (or the pi tune) as the session model, the MoE as the subagent default. */
export function pairSettings(settings: unknown): boolean {
	const s = settings as { defaultModel?: unknown; subagents?: { defaultModel?: unknown } } | undefined;
	const main = typeof s?.defaultModel === "string" ? s.defaultModel : "";
	const sub = typeof s?.subagents?.defaultModel === "string" ? s.subagents.defaultModel : "";
	return (main.endsWith("pair-auto") || main.endsWith("qwen3.8-27b-pi")) && sub.endsWith("qwen3.6-35b-a3b-sglang");
}

/** The file is app code: inside an app (or one of its worktrees) and not docs, Markdown, CI config or the plan workspace. */
export function appCodePath(raw: string, cwd: string, home: string): boolean {
	const expanded = raw.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home);
	const path = isAbsolute(expanded) ? expanded : join(cwd, expanded);
	const apps = join(home, "workspace", "apps");
	if (!path.startsWith(`${apps}/`)) return false;
	let rel = path.slice(apps.length + 1);
	rel = rel.startsWith("worktrees/") ? rel.split("/").slice(3).join("/") : rel.split("/").slice(1).join("/");
	return rel !== "" && !/^(?:docs|\.superpowers|\.github)\//.test(rel) && !/\.md$/i.test(rel);
}

const WRITES = /(?:^|[\s|])(?:sed\s+(?:-\S+\s+)*-[A-Za-z]*i|perl\s+(?:-\S+\s+)*-[A-Za-z]*i|tee|rm|mv|cp|truncate|git\s+apply|git\s+checkout\s+\S+\s+--|git\s+restore|npm\s+(?:i|install|uninstall|rm)|pnpm\s+(?:add|remove|i|install)|yarn\s+(?:add|remove))(?![\w-])|(?<![0-9&])>{1,2}(?!&)/;

/** A shell command that writes app code: a writing verb or a redirect in a segment that names an app code path. */
export function writesAppCode(command: string, cwd: string, home: string): boolean {
	const dir = workDir(command, cwd, home);
	for (const seg of command.split(/;|&&|\|\||\n/)) {
		const bare = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
		if (!WRITES.test(bare)) continue;
		const paths = bare.split(/\s+/).filter((t) => /^(?:~|\$HOME|\/|\.{1,2}\/)|\/|\.[A-Za-z0-9]{1,6}$/.test(t) && !/^[<>|&;-]/.test(t));
		if (paths.some((p) => appCodePath(p, dir, home))) return true;
	}
	return false;
}

// The directory a command runs in: its leading `cd`, else the session cwd.
export function workDir(command: string, cwd: string, home: string): string {
	const target = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1].replace(/^["']|["']$/g, "");
	if (!target) return cwd;
	return target.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

// True when a command runs the whole e2e suite rather than one spec or a grep.
export function fullE2e(command: string): boolean {
	if (/\bBASE_URL=/.test(command)) return false; // checking a deployed site
	// Quoted text is an argument (a grep pattern, a commit message), not a command that runs.
	const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
	for (const m of bare.matchAll(/\b(?:npm\s+run\s+e2e(?![:\w-])|playwright\s+test\b)([^;&|\n]*)/g)) {
		if (!/\.spec\.|\.ts\b|\s(?:-g|--grep)\b/.test(m[1])) return true;
	}
	return false;
}

export function pythonRewrite(code: string): boolean {
	return /\bopen\([^)]*,\s*["'][wa]\+?b?["']|\.write_text\(|\.write_bytes\(/.test(code);
}

export type Env = {
	cwd: string;
	home: string;
	hasScript: (dir: string, name: string) => boolean;
	dirty: (dir: string) => boolean;
	/** The app's current state was reviewed (a scoped reviewer finished since Michael's last message, or nothing
	 *  changed since the last review). Absent: not checked. */
	reviewed?: (dir: string) => boolean;
	/** The branch changes more than docs, Markdown and CI files. */
	codeChanged?: (dir: string) => boolean;
	/** The branch adds or changes a design doc or plan under docs/superpowers (a PR of one needs a doc review). */
	docsChanged?: (dir: string) => boolean;
	/** Why the review gate is shut for the app, when `reviewed` is false (reviewGap). Absent: the plain reason. */
	reviewGap?: (dir: string) => string | undefined;
	/** The git root of a path under ~/workspace outside apps (a worktree is its own root), undefined when there is none.
	 *  Absent: pushes and PRs from repos outside apps are not gated. */
	repoRoot?: (path: string) => string | undefined;
	/** Line count of an existing file, undefined when there is none. Absent: overwrites are not checked. */
	lines?: (path: string) => number | undefined;
	/** Paths whose overwrite was already blocked once; the second try goes through. */
	rewrites?: Set<string>;
	/** This session is the agent pair's orchestrator (pair settings, not a subagent child): it never edits app code. */
	orchestrator?: boolean;
	/** The run id of a worker still running in the app's main checkout, if any (busyWorker). Absent: not checked. */
	busy?: (dir: string) => string | undefined;
	/** The app's screen, as its UI files are now, came back as a picture in a tool result (screenUpToDate). Absent: not checked. */
	screenSeen?: (dir: string) => boolean;
	/** The branch changes UI files (uiFile) against main. Absent: assume it does. */
	uiChanged?: (dir: string) => boolean;
};

/** A file whose change can change what the app draws. */
export const uiFile = (path: string) => /^(?:index\.html|src\/.+\.(?:ts|js|css|html)|public\/.+\.css)$/.test(path);

const SCREENSHOT = /thatsit-app\.ts\s+screenshot\b/;
const SHIPS = /thatsit-app\.ts\s+ship\b/;

/** The app a `screenshot` command pictures, or undefined for any other command. */
export const screenshotDir = (command: string, cwd: string, home: string): string | undefined => (SCREENSHOT.test(command) ? appDir(command, cwd, home) : undefined);

/** The file a `screenshot` command loads into the app (`--upload <file>`), with `~` expanded; undefined without one. */
export function screenshotUpload(command: string, home: string): string | undefined {
	const m = /--upload\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
	const file = m?.[1] ?? m?.[2] ?? m?.[3];
	return file ? file.replace(/^~(?=\/)/, home) : undefined;
}

/** Appended by the guard to a screenshot command's result, beside the picture: the app state it shows, and the file
 *  it was loaded with. */
export const SCREEN_MARK = "[pi-guard] screen seen ";
export const screenMark = (dir: string, snap: string, upload?: string) => `${SCREEN_MARK}${dir} at ${snap}${upload ? ` with ${upload}` : ""}`;
const SEEN = /\[pi-guard\] screen seen (\S+) at ([0-9a-f]{7,64})/g;

/** The files Michael's request names by path (`~/x/y.json`, `/home/.../y.json`) that exist: the data the change
 *  reads, which the review checks the tests against and the screen is pictured with. At most four, in order. */
export function requestFiles(request: string | undefined, home: string, isFile: (path: string) => boolean = defaultIsFile): string[] {
	if (!request) return [];
	const out: string[] = [];
	for (const m of request.matchAll(/(?:^|[\s"'`(\[<])((?:~\/|\/)[\w.@+-]+(?:\/[\w.@+-]+)*)/g)) {
		const path = m[1].replace(/[.,;:!?]+$/, "").replace(/^~(?=\/)/, home);
		if (out.includes(path) || !isFile(path)) continue;
		out.push(path);
		if (out.length === 4) break;
	}
	return out;
}

function defaultIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** A picture Michael sent on this branch, with the words it came with: a reference the screen is compared against,
 *  or the broken screen he saw. The branch keeps them through compaction, so the comparison outlives the context. */
export type UserPicture = { text: string; data: string; mimeType: string };
export const MAX_USER_PICTURES = 2;
export function userPictures(branch: Iterable<unknown>, max = MAX_USER_PICTURES): UserPicture[] {
	const out: UserPicture[] = [];
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type !== "message" || e.message?.role !== "user" || !Array.isArray(e.message.content)) continue;
		const parts = e.message.content as { type?: string; text?: string; data?: string; mimeType?: string }[];
		const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").replace(/\s+/g, " ").trim();
		for (const p of parts) if (p.type === "image" && p.data) out.push({ text, data: p.data, mimeType: p.mimeType ?? "image/png" });
	}
	return out.slice(-max);
}

/** The blocks that follow the picture in a screenshot result: the spec and Michael's pictures to compare it with, then
 *  the comparison the orchestrator owes before going on. The fret run of 2026-11-13 22:08 passed a board with the nut on
 *  the wrong side and no degree numbers because "looks right" was judged against nothing. */
export function screenCompareContent(spec: string | undefined, pictures: UserPicture[], inputs: string[] = [], upload?: string): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
	const out: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
	// A picture of the shipped content is not a look at a change that reads Michael's file: keeb 2026-11-17 (PR #31)
	// pictured the default board, and the legend showing "9" where his Sym layer types "(" was never seen.
	if (inputs.length && !(upload && inputs.includes(upload))) {
		out.push({
			type: "text",
			text: `[pi-guard] Michael's request names ${inputs.join(" and ")}, and this picture was taken without it. If the app reads such a file, run the screenshot command again with --upload ${inputs[0]} (and --click '<selector>' for the control that opens the file input, if one is needed): the picture must show his data, and what it draws for that file counts, not what it draws for the shipped content.`,
		});
	}
	if (spec) out.push({ type: "text", text: `docs/spec.md, what the screen must match:\n\n${spec}` });
	for (const p of pictures) {
		out.push({ type: "text", text: `Michael sent this picture with: "${p.text.slice(0, 300)}"` });
		out.push({ type: "image", data: p.data, mimeType: p.mimeType });
	}
	const against = [spec ? "docs/spec.md" : "", pictures.length ? "Michael's pictures above (what he asked for, or what he saw broken)" : "", "Michael's request"].filter(Boolean).join(", ");
	out.push({
		type: "text",
		text: `Compare the screen with ${against} and write down what differs before going on: elements missing or extra, order and side (left-handed layouts, nut, labels), colours by role, numbers and labels in each element. A difference goes back to the worker with the picture's path; the review waits. Only when nothing differs, go on. If the change, or Michael's picture, is in a state this screen does not show (an open dialog or menu, another route), picture that state first: the screenshot command with --click '<css selector of the control that opens it>' or --path /route. "Not visible in this screenshot" is not a pass.`,
	});
	return out;
}

/** The snapshot commit the last picture of `dir` showed, from the marks on the branch. */
export function lastScreen(branch: Iterable<unknown>, dir: string): string | undefined {
	let snap: string | undefined;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message.isError) continue;
		for (const m of resultText(e.message).matchAll(SEEN)) if (m[1] === dir) snap = m[2];
	}
	return snap;
}

/** The picture file a finished `screenshot` command reports (its RESULT line), or undefined when it reported none. */
export function screenResult(text: string): string | undefined {
	const m = /^RESULT (\{.*\})\s*$/m.exec(text);
	if (!m) return undefined;
	try {
		const r = JSON.parse(m[1]) as { ok?: unknown; file?: unknown };
		return r.ok === true && typeof r.file === "string" ? r.file : undefined;
	} catch {
		return undefined;
	}
}

// Commands that start the e2e server in an app: the verify gate, the e2e scripts, playwright itself.
const RUNS_E2E = /\bnpm\s+run\s+(?:verify|e2e(?::[\w-]+)?)\b|\bplaywright\s+test\b/;

const INSTALLS = /\b(?:npm\s+(?:ci|i|install)|pnpm\s+(?:i|install)|yarn(?:\s+install)?)\b/;

const GIT = String.raw`\bgit(?:\s+-[Cc]\s+(?:[^\s"']|"[^"]*"|'[^']*')+|\s+-\S+)*\s+`;

// Commands that overwrite working-tree files with a committed version.
export function discards(command: string): boolean {
	for (const seg of command.split(/;|&&|\|\||\||\n/)) {
		if (new RegExp(`${GIT}checkout\\b.*\\s--(\\s|$)`).test(seg)) return true;
		if (new RegExp(`${GIT}restore\\b`).test(seg) && !(/\s(?:-S|--staged)\b/.test(seg) && !/\s(?:-W|--worktree)\b/.test(seg))) return true;
		if (new RegExp(`${GIT}reset\\b.*\\s--hard\\b`).test(seg)) return true;
	}
	return false;
}

export function checkShell(command: string, env: Env): Block | undefined {
	// Merging needs no app path in the command (`gh pr merge 28 --repo thats-it-dev/keeb` names only the repo).
	if (merges(command)) return { block: true, reason: REASONS.merge };
	const dir = appDir(command, env.cwd, env.home);
	if (!dir) return checkRepoShell(command, env);
	if (PUSHES.test(command)) return { block: true, reason: REASONS.push };
	if (INSTALLS.test(command) && workDir(command, env.cwd, env.home).startsWith(`${join(env.home, "workspace", "apps", "worktrees")}/`)) return { block: true, reason: REASONS.worktreeInstall };
	if (env.orchestrator && writesAppCode(command, env.cwd, env.home)) return { block: true, reason: REASONS.orchestrator };
	if (/\bgh\s+(?:run\s+(?:list|watch)|pr\s+checks)\b/.test(command)) return { block: true, reason: REASONS.ci };
	if (/\bgh\s+run\s+view\b/.test(command) && !/--log-failed\b/.test(command)) return { block: true, reason: REASONS.ci };
	// A short sleep (a server starting, a deploy propagating) is fine; CI polling used minutes.
	const sleep = /\bsleep\s+(\d+)/.exec(command);
	if (sleep && Number(sleep[1]) >= 60) return { block: true, reason: REASONS.ci };
	if (/\bpython3?\b/.test(command) && pythonRewrite(command) && appDir("", workDir(command, env.cwd, env.home), env.home)) {
		return { block: true, reason: REASONS.rewrite };
	}
	if (RUNS_E2E.test(command) && env.busy) {
		const worker = env.busy(dir);
		if (worker) return { block: true, reason: workerBusy(worker) };
	}
	if (fullE2e(command) && env.hasScript(dir, "e2e:one")) return { block: true, reason: REASONS.e2e };
	if (discards(command) && env.dirty(dir)) return { block: true, reason: REASONS.discard };
	// A first version always has a screen; a PR needs the look only when it changes UI files.
	if (env.screenSeen && (SHIPS.test(command) || (OPENS_PR.test(command) && (env.uiChanged?.(dir) ?? true))) && !env.screenSeen(dir)) return { block: true, reason: REASONS.screen };
	if (OPENS_PR.test(command) && env.reviewed && !env.reviewed(dir) && ((env.codeChanged?.(dir) ?? true) || (env.docsChanged?.(dir) ?? false))) {
		const gap = env.reviewGap?.(dir);
		return { block: true, reason: gap ? `${REASONS.review}\n${gap}` : REASONS.review };
	}
	return undefined;
}

const OPENS_PR = /thatsit-app\.ts\s+(?:pr|gateway-pr)\b(?!-wait)/;
const PUSHES = /\bgit(?:\s+-[Cc]\s+(?:[^\s"']|"[^"]*"|'[^']*')+|\s+-\S+)*\s+push\b/;
const PUBLISHES = new RegExp(`${PUSHES.source}|\\bgh\\s+pr\\s+create\\b`);

// Any other git repo under ~/workspace gets an app's review gate at its own publish point, a push or `gh pr create`,
// without the skill's scripts. Why: the website session of 2026-11-19 pushed a 77-file branch and opened its PR with
// no review at all, because ~/workspace/ref/website is not an app.
function checkRepoShell(command: string, env: Env): Block | undefined {
	if (!PUBLISHES.test(command) || !env.reviewed || !env.repoRoot) return undefined;
	const at = workspacePath(command, env.cwd, env.home);
	const repo = at ? env.repoRoot(at) : undefined;
	if (!repo || env.reviewed(repo)) return undefined;
	if (!((env.codeChanged?.(repo) ?? true) || (env.docsChanged?.(repo) ?? false))) return undefined;
	const gap = env.reviewGap?.(repo);
	return { block: true, reason: gap ? `${REASONS.reviewRepo}\n${gap}` : REASONS.reviewRepo };
}

/** Files a PR can change without a code review: docs, Markdown and CI config. */
export function reviewFree(path: string): boolean {
	return /^(?:docs|\.github)\//.test(path) || /\.md$/i.test(path);
}

/** A design doc or implementation plan: it gets a doc review (claims against the code, plan against the spec). */
export function designDoc(path: string): boolean {
	return /^docs\/superpowers\/(?:specs|plans)\/[^/]+\.md$/i.test(path);
}

// --- review before PR ---

type Entry = { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
type ToolCallPart = { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

/** Appended to a scoped review's result by the guard; records which app state the review covered. */
export const REVIEW_MARK = "[pi-guard] reviewed ";
export const reviewMark = (dir: string, snap: string) => `${REVIEW_MARK}${dir} at ${snap}`;

const resultText = (m: Entry["message"]) =>
	Array.isArray(m?.content) ? (m.content as { type?: string; text?: string }[]).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n") : "";

/** A scoped review launched async: the mark goes on the launch result, and counts once the run completes. */
export const REVIEW_PENDING_MARK = "[pi-guard] review pending ";
export const reviewPendingMark = (dir: string, snap: string, runId: string) => `${REVIEW_PENDING_MARK}${dir} at ${snap} run ${runId}`;

/** The state of a pi-subagents async run: `complete` is the only state that makes a pending review count. */
export type RunState = (runId: string) => "complete" | "running" | "failed" | "missing";

// pi-subagents' async run dir: its temp root (PI_SUBAGENTS_TEMP_ROOT, else /tmp/pi-subagents-uid-<uid>) + async-subagent-runs.
const ASYNC_RUNS = join(process.env.PI_SUBAGENTS_TEMP_ROOT?.trim() || `/tmp/pi-subagents-uid-${process.getuid?.() ?? 1000}`, "async-subagent-runs");

/** The reply text the reviewer.md contract asks for: a `## Review` block with findings or a merge verdict, or the exact
 *  `No issues found.` line. A reviewer that stops mid-review, or writes its report inside its reasoning, returns neither
 *  (keeb run 2026-11-12 22:45), and a review the orchestrator cannot act on must not open the PR gate. */
export function reviewVerdict(text: string): boolean {
	if (/\bNo (?:issues|defects|problems) found\b/.test(text)) return true;
	// The label may be emphasised (`- **Merge verdict**: OK`), a finding may lead with its level (`- **P2:** ...`), the
	// line may carry no list dash at all (`**Finding:** None.`, fret 2026-11-14 21:33), or be a heading (`## Merge
	// verdict: OK`, `#### P1 — ...`: every one of the 35B's five scoped reviews on keeb 2026-11-16, all discarded, and
	// the PR never opened): all read fine, and a review that counts for the reader must count for the gate.
	return /^\s*#+\s*Review\b/m.test(text) && /^\s*(?:#+\s*|-\s*)?(?:\*\*|__)?\s*(?:Finding|Merge verdict|P[012]\b)\s*(?:\*\*|__)?\s*(?::|—|–|-\s)/m.test(text);
}

/** A review whose verdict shuts the PR gate: a `Merge verdict` line that says BLOCK, or, without a verdict line, a P0
 *  or P1 finding. Keeb 2026-11-17 18:27: the reviewer wrote `**Merge verdict: BLOCK**` with a P0, the orchestrator
 *  argued it away in its own reasoning, the guard's "nothing changed since the last review" answer sent it on to `pr`,
 *  and the gate, which counted any verdict, let the PR through. */
export function reviewBlocked(text: string): boolean {
	if (!reviewVerdict(text)) return false;
	const verdict = /^\s*(?:#+\s*|-\s*)?(?:\*\*|__)?\s*Merge verdict\s*(?:\*\*|__)?\s*(?::|—|–|-\s)(?:\s*(?:\*\*|__))*\s*([A-Za-z]+)/m.exec(text);
	if (verdict) return verdict[1].toUpperCase() === "BLOCK";
	return /^\s*(?:#+\s*|-\s*)?(?:\*\*|__)?\s*(?:Finding\s*(?:\*\*|__)?\s*(?::|—|–|-\s)\s*(?:\*\*|__)?\s*)?P[01]\b/m.test(text);
}

/** A scoped sync review that ended BLOCK: the mark records the snapshot so a second call on the same tree is refused,
 *  and it never counts for the PR gate or as the next review's base. */
export const reviewBlockedMark = (dir: string, snap: string) => `[pi-guard] review blocked ${dir} at ${snap}`;

/** Appended instead of the reviewed mark when a sync review returns without a verdict. */
export const REVIEW_NO_VERDICT = "[pi-guard] review ended without a verdict: the reply has no `## Review` block with findings or a merge verdict, and no `No issues found.` line (the reviewer stopped mid-review or left its report in its reasoning). This review does not count: call the reviewer again, same task, and read its reply before going on.";

/** The reviewer's reply text of a finished run, or undefined when it cannot be read: a review the guard can't read never counts. */
export type RunText = (runId: string) => string | undefined;

/** Joins the text parts of every assistant message in the run's session file (status.json `sessionFile`): never
 *  thinking, never tool results, so a verdict quoted inside a file the reviewer read does not count. */
export function defaultRunText(runId: string, root: string = ASYNC_RUNS): string | undefined {
	try {
		const file = String((JSON.parse(readFileSync(join(root, runId, "status.json"), "utf8")) as { sessionFile?: unknown }).sessionFile ?? "");
		const out: string[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const e = JSON.parse(line) as Entry;
			if (e.type === "message" && e.message?.role === "assistant") for (const t of resultText(e.message).split("\n")) if (t.trim()) out.push(t);
		}
		return out.join("\n");
	} catch {
		return undefined;
	}
}

/** A pending mark whose launch result carried no run id: it can never resolve, so it never counts. */
export const UNKNOWN_RUN = "unknown";

/** Reads the run's status.json under `root`; a missing or unreadable file is `missing` (the run dir ages out), never `complete`. */
export function defaultRunState(runId: string, root: string = ASYNC_RUNS): ReturnType<RunState> {
	try {
		const state = String((JSON.parse(readFileSync(join(root, runId, "status.json"), "utf8")) as { state?: unknown }).state);
		if (state === "complete") return "complete";
		return /fail|error|stopp|timeout|cancel/i.test(state) ? "failed" : "running";
	} catch {
		return "missing";
	}
}

/** The run id of an async reviewer launch, from pi-subagents' launch result. */
export const asyncRunId = (resultText: string): string | undefined => /Async: reviewer \[([0-9a-f-]{36})\]/.exec(resultText)?.[1];

const PENDING = /\[pi-guard\] review pending (\S+) at ([0-9a-f]{7,64}) run (\S+)/g;
const FINISHED = /\[pi-guard\] reviewed (\S+) at ([0-9a-f]{7,64})/g;
const BLOCKED = /\[pi-guard\] review blocked (\S+) at ([0-9a-f]{7,64})/g;

type ReviewRecord = { dir: string; snap: string; at: number };

/** The reviews a tool result records, in order: finished ones (the guard wrote that mark only after seeing a verdict
 *  that was not BLOCK), and pending ones whose run is complete and whose reply holds a verdict other than BLOCK. */
function completedReviews(text: string, runState: RunState, runText: RunText): ReviewRecord[] {
	const out: ReviewRecord[] = [];
	for (const m of text.matchAll(FINISHED)) out.push({ dir: m[1], snap: m[2], at: m.index ?? 0 });
	for (const m of text.matchAll(PENDING)) {
		if (m[3] === UNKNOWN_RUN || runState(m[3]) !== "complete") continue;
		const reply = runText(m[3]) ?? "";
		if (reviewVerdict(reply) && !reviewBlocked(reply)) out.push({ dir: m[1], snap: m[2], at: m.index ?? 0 });
	}
	return out.sort((a, b) => a.at - b.at);
}

/** The reviews a tool result records that ended BLOCK: a blocked mark, or a pending one whose finished reply says so. */
function blockedReviews(text: string, runState: RunState, runText: RunText): ReviewRecord[] {
	const out: ReviewRecord[] = [];
	for (const m of text.matchAll(BLOCKED)) out.push({ dir: m[1], snap: m[2], at: m.index ?? 0 });
	for (const m of text.matchAll(PENDING)) if (m[3] !== UNKNOWN_RUN && runState(m[3]) === "complete" && reviewBlocked(runText(m[3]) ?? "")) out.push({ dir: m[1], snap: m[2], at: m.index ?? 0 });
	return out.sort((a, b) => a.at - b.at);
}

/** The snapshot of the last scoped review of `dir` that ended BLOCK, unless a review that counted came after it. */
export function lastBlockedReview(branch: Iterable<unknown>, dir: string, runState: RunState = defaultRunState, runText: RunText = defaultRunText): string | undefined {
	let snap: string | undefined;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message.isError) continue;
		const text = resultText(e.message);
		const all = [...completedReviews(text, runState, runText).map((r) => ({ ...r, blocked: false })), ...blockedReviews(text, runState, runText).map((r) => ({ ...r, blocked: true }))].sort((a, b) => a.at - b.at);
		for (const r of all) if (r.dir === dir) snap = r.blocked ? r.snap : undefined;
	}
	return snap;
}

/** True when a review the guard scoped completed without error after Michael's last message on the branch. */
export function reviewedSinceUser(branch: Iterable<unknown>, runState: RunState = defaultRunState, runText: RunText = defaultRunText): boolean {
	let reviewed = false;
	for (const raw of branch) {
		const e = raw as Entry;
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "user") reviewed = false;
		else if (m.role === "toolResult" && !m.isError && completedReviews(resultText(m), runState, runText).length > 0) reviewed = true;
	}
	return reviewed;
}

/** The snapshot commit the last completed scoped review of `dir` covered, from the marks on the branch. */
export function lastReview(branch: Iterable<unknown>, dir: string, runState: RunState = defaultRunState, runText: RunText = defaultRunText): string | undefined {
	let snap: string | undefined;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message.isError) continue;
		for (const r of completedReviews(resultText(e.message), runState, runText)) if (r.dir === dir) snap = r.snap;
	}
	return snap;
}

/** Appended to a reviewer launch the guard did not scope: it will never count for the PR gate, and the model
 *  should know that now, not after ten blocked `pr` calls (keeb 2026-11-16: 11 unscoped reviews in a row). */
export const REVIEW_UNSCOPED = "[pi-guard] this review is not scoped to a repo (the task names no path under ~/workspace and the call's cwd is not in one), so it does not count for the PR gate. Call the reviewer again with `cwd` set to the app or repo, or with its path in the task.";

/** The gap line for a review that ended BLOCK: the orchestrator's own reading of the findings does not reopen the gate. */
const REVIEW_BLOCKED_GAP = (who: string) =>
	`${who} ended with the merge verdict BLOCK, and it counts for nothing until a changed tree is reviewed again: send its P0 and P1 findings to the worker, run \`npm run verify\`, commit, and call the reviewer again. If you are sure a finding is wrong, don't argue it with the reviewer or in your own reasoning: tell Michael which finding and why, and end your turn. The gate stays shut until he says.`;

const REVIEW_BLOCK_HEAD = "Blocked: run the reviewer before opening the PR";

/** Why the review gate is shut for `dir` after Michael's last message: no scoped review, one still running, one that
 *  ended without a verdict, or one that failed. Prefixed by a stop order once `pr` was blocked three times with no new
 *  review in between: the orchestrator is looping (keeb 2026-11-16: 16 blocked `pr` calls over 2 h 48 min). */
export function reviewGap(branch: Iterable<unknown>, dir: string, runState: RunState = defaultRunState, runText: RunText = defaultRunText): string | undefined {
	let last: { kind: "pending"; runId: string } | { kind: "finished" } | { kind: "blocked" } | undefined;
	let blocks = 0;
	for (const raw of branch) {
		const e = raw as Entry;
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "user") {
			last = undefined;
			blocks = 0;
			continue;
		}
		if (m.role !== "toolResult") continue;
		const text = resultText(m);
		if (m.isError) {
			if (text.startsWith(REVIEW_BLOCK_HEAD)) blocks++;
			continue;
		}
		const marks: { at: number; last: NonNullable<typeof last> }[] = [];
		for (const f of text.matchAll(FINISHED)) if (f[1] === dir) marks.push({ at: f.index ?? 0, last: { kind: "finished" } });
		for (const b of text.matchAll(BLOCKED)) if (b[1] === dir) marks.push({ at: b.index ?? 0, last: { kind: "blocked" } });
		for (const p of text.matchAll(PENDING)) if (p[1] === dir) marks.push({ at: p.index ?? 0, last: { kind: "pending", runId: p[3] } });
		for (const m of marks.sort((a, b) => a.at - b.at)) {
			last = m.last;
			blocks = 0;
		}
	}
	let why: string;
	if (!last) why = "No reviewer call since Michael's last message was scoped to this repo: the guard scopes a `subagent` call with agent \"reviewer\" whose `cwd` is the app or repo, or whose task names its path under ~/workspace, and only those count.";
	else if (last.kind === "finished") return undefined;
	else if (last.kind === "blocked") why = REVIEW_BLOCKED_GAP("The last scoped review");
	else if (last.runId === UNKNOWN_RUN) why = "The last scoped review's launch result carried no run id, so it can never count: call the reviewer again.";
	else {
		const state = runState(last.runId);
		const reply = state === "complete" ? runText(last.runId) ?? "" : "";
		if (state === "running") why = `The last scoped review (run ${last.runId.slice(0, 8)}) is still running: wait for its subagent-notify message, then run this command again.`;
		else if (state === "complete" && reviewBlocked(reply)) why = REVIEW_BLOCKED_GAP(`The last scoped review (run ${last.runId.slice(0, 8)})`);
		else if (state === "complete") why = reviewVerdict(reply) ? "" : `The last scoped review (run ${last.runId.slice(0, 8)}) ended without a verdict the guard accepts: a \`## Review\` block with a Finding, Merge verdict or P0-P2 line, or \`No issues found.\`. Call the reviewer again and ask for that shape.`;
		else why = `The last scoped review (run ${last.runId.slice(0, 8)}) ${state === "missing" ? "has no run directory any more" : "failed"}: call the reviewer again.`;
	}
	if (!why) return undefined;
	const stop = blocks >= 3 ? `This is the ${blocks + 1}th time this command is blocked with no new review in between: stop retrying. Tell Michael the PR is blocked, quote the line below, and end your turn.\n` : "";
	return `${stop}${why}`;
}

/** The app a reviewer call is about: an apps path in the task, then a /tmp/<name>-review.diff naming an app that
 *  exists (a repo outside apps gets the same diff name, and is not an app), then the cwd. */
export function reviewApp(task: string, cwd: string, home: string, isDir: (path: string) => boolean = defaultIsDir): string | undefined {
	const named = appDir(task, "", home);
	if (named) return named;
	const diff = /\/tmp\/([A-Za-z0-9._-]+)-review\.diff/.exec(task)?.[1];
	const fromDiff = diff ? join(home, "workspace", "apps", diff) : undefined;
	return fromDiff && isDir(fromDiff) ? fromDiff : appDir("", cwd, home);
}

function defaultIsDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A subagent call that runs a reviewer some way other than a direct `agent: "reviewer"` call. */
export function indirectReviewer(input: Record<string, unknown>): boolean {
	if (input.agent !== undefined) return false;
	const { workflow, chain, tasks, script } = input;
	return [workflow, chain, tasks, script].some((v) => v !== undefined && /\breviewer\b/.test(typeof v === "string" ? v : JSON.stringify(v)));
}

/** True when `npm run verify` passed in `dir` after the last edit or write to a code file there. */
export function verifiedSinceEdit(branch: Iterable<unknown>, dir: string, cwd: string, home: string): boolean {
	const verifies = new Set<string>();
	let lastEdit = -1;
	let lastVerify = -1;
	let i = 0;
	for (const raw of branch) {
		i++;
		const e = raw as Entry;
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content as ToolCallPart[]) {
				if (c.type !== "toolCall") continue;
				const path = c.arguments?.path;
				if ((c.name === "edit" || c.name === "write") && typeof path === "string") {
					const abs = path.replace(/^~(?=\/)/, home);
					const full = isAbsolute(abs) ? abs : join(cwd, abs);
					if (full.startsWith(`${dir}/`) && !reviewFree(full.slice(dir.length + 1))) lastEdit = i;
				}
				const command = c.arguments?.command;
				// An app is named by its path; any other repo by the command's `cd` (or the session cwd).
				if (c.name === "bash" && typeof command === "string" && /\bnpm\s+run\s+verify\b/.test(command) && (appDir(command, cwd, home) ?? workDir(command, cwd, home)) === dir && c.id) verifies.add(c.id);
			}
		} else if (m.role === "toolResult" && m.toolCallId && verifies.has(m.toolCallId) && !m.isError) {
			lastVerify = i;
		}
	}
	return lastVerify > lastEdit;
}

const WORKER_RUN = /Async: worker \[([0-9a-f-]{36})\]/;
const REVIVED_RUN = /Revived run: ([0-9a-f-]{36})/;

/** Async worker runs launched without `worktree: true`, from the branch: run id -> the app dir the launch named
 *  (task text or `cwd`), or undefined when it named none (runDir then reads it off the run). A resume revives a
 *  run under a new id, which inherits the launch's dir. */
export function workerRuns(branch: Iterable<unknown>, cwd: string, home: string): Map<string, string | undefined> {
	const launches = new Map<string, string | undefined>(); // tool call id -> app dir
	const resumes = new Map<string, string>(); // tool call id -> the run (or prefix) resumed
	const runs = new Map<string, string | undefined>();
	for (const raw of branch) {
		const e = raw as Entry;
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content as ToolCallPart[]) {
				if (c.type !== "toolCall" || c.name !== "subagent" || !c.id) continue;
				const a = c.arguments ?? {};
				if (a.agent === "worker" && a.worktree !== true) {
					launches.set(c.id, appDir(String(a.task ?? ""), typeof a.cwd === "string" ? a.cwd : cwd, home));
				} else if (a.action === "resume" && typeof a.id === "string") {
					resumes.set(c.id, a.id);
				}
			}
		} else if (m.role === "toolResult" && m.toolCallId && !m.isError) {
			const text = resultText(m);
			if (launches.has(m.toolCallId)) {
				const id = WORKER_RUN.exec(text)?.[1];
				if (id) runs.set(id, launches.get(m.toolCallId));
			}
			const resumed = resumes.get(m.toolCallId);
			if (resumed) {
				const from = [...runs.keys()].find((id) => id.startsWith(resumed));
				const id = REVIVED_RUN.exec(text)?.[1];
				if (from && id) runs.set(id, runs.get(from));
			}
		}
	}
	return runs;
}

/** Where a run works, read off its status.json: the app whose main checkout its cwd or its tool calls (the
 *  `recentTools` args pi-subagents keeps per step) are in; `WORKTREE` when they are all in worktrees; undefined when
 *  the run has not shown yet (no file, no app path). */
export type RunDir = (runId: string) => string | typeof WORKTREE | undefined;
export const WORKTREE = Symbol("worktree");

export function defaultRunDir(runId: string, home: string, root: string = ASYNC_RUNS): ReturnType<RunDir> {
	let status: { cwd?: unknown; steps?: { recentTools?: { args?: unknown }[] }[] };
	try {
		status = JSON.parse(readFileSync(join(root, runId, "status.json"), "utf8"));
	} catch {
		return undefined;
	}
	const apps = join(home, "workspace", "apps");
	// A worktree worker may read the main checkout, a main-checkout worker never touches a worktree: any worktree
	// path means a worktree. Tool calls say more than the cwd, which is the launch's (often `~`, or the app for a worktree run).
	const found = (texts: string[]): string | typeof WORKTREE | undefined => {
		let main: string | undefined;
		for (const text of texts) {
			for (const m of text.matchAll(/\/workspace\/apps\/([A-Za-z0-9._-]+)(?=\/|\s|$)/g)) {
				if (m[1] === "worktrees") return WORKTREE;
				if (!main && text.slice(0, m.index).endsWith(home)) main = join(apps, m[1]);
			}
		}
		return main;
	};
	const tools = (status.steps ?? []).flatMap((s) => (s.recentTools ?? []).map((t) => (typeof t.args === "string" ? t.args : "")));
	return found(tools) ?? found([typeof status.cwd === "string" ? status.cwd : ""]);
}

/** The id of a worker still running in `dir`'s main checkout, if any. A worker that has not shown where it works
 *  yet holds every checkout; one in a worktree holds none. A run whose dir aged out never counts. */
export function busyWorker(branch: Iterable<unknown>, dir: string, cwd: string, home: string, runState: RunState = defaultRunState, runDir: RunDir = (id) => defaultRunDir(id, home)): string | undefined {
	for (const [id, launched] of workerRuns(branch, cwd, home)) {
		if (runState(id) !== "running") continue;
		const at = launched ?? runDir(id);
		if (at === undefined || at === dir) return id;
	}
	return undefined;
}

/** Read and search calls a scoped reviewer gets. At `soft` it is told to finish; after `hard` every tool is blocked. */
export const REVIEW_BUDGET = { soft: 12, hard: 20, block: "*" } as const;

export type ReviewScope = {
	dir: string;
	/** "docs" when the diff holds no code: a design doc or plan review, briefed differently (no tests to cite). */
	kind?: "code" | "docs";
	/** Michael's last message on the branch, verbatim (lastRequest): what the review must check the diff against. */
	request?: string;
	/** The files that message names by path and that exist (requestFiles): the data the change reads. */
	inputs?: string[];
	/** Where the diff starts: the last review's snapshot, or the branch point from main. */
	base: string;
	baseFrom: "review" | "main";
	diffPath: string;
	files: { path: string; added: string; removed: string }[];
};

/** The scope the guard puts in front of the parent's review task. */
export function reviewHeader(s: ReviewScope): string {
	const files = s.files.map((f) => `- ${f.path} (+${f.added} -${f.removed})`).join("\n");
	const from =
		s.baseFrom === "review"
			? `the state the last review covered (${s.base.slice(0, 8)}); everything before it was already reviewed, so don't review it again`
			: `where the branch left main (${s.base.slice(0, 8)})`;
	if (s.kind === "docs") return docReviewHeader(s, files, from);
	return [
		"[Review scope, set by pi-guard. Follow it exactly.]",
		`App: ${s.dir} (your working directory). Its AGENTS.md, if it has one, is already in your context.`,
		`Diff: ${s.diffPath}, every change from ${from} to the current working tree, uncommitted and new files included, lockfiles and build output left out.`,
		`Changed files:\n${files}`,
		"`npm run verify` (typecheck, lint, guardrail tests, unit tests and e2e tests) passed after the last code edit. Don't check whether tests pass or run, and don't read config, CI, lock, test-result, coverage or git files.",
		`Read the diff first. Open a file outside the list only to check a caller, a definition or a contract the diff depends on. Put independent reads in one turn. You have ${REVIEW_BUDGET.hard} tool calls; at ${REVIEW_BUDGET.soft} write your review.`,
		...(s.request
			? [
					"",
					"[Michael's request, verbatim. The parent's summary below may have lost part of it.]",
					s.request,
					"",
					"For each behavior Michael names (what a key, control or input must do, with the file or layout he names), cite the test in the diff that drives that exact input and asserts that behavior (path:line). A named behavior with no such test is a P1 finding and the merge verdict is BLOCK. A test that asserts the behavior Michael says is wrong is a P1 and BLOCK too. Passing tests prove nothing about a behavior no test drives.",
					...(s.inputs?.length ? ["", inputsOracle(s.inputs)] : []),
				]
			: []),
		"",
		"[The parent's request]",
	].join("\n");
}

/** The brief for a design doc or plan review. On keeb 2026-11-17 (flash, PR #31) the plan review went out with the
 *  code brief: "verify passed", "cite the test per named behavior" on a diff with no code in it, after a needless
 *  `npm run verify` to open the gate. A doc is checked against the code it describes and the spec it implements. */
function docReviewHeader(s: ReviewScope, files: string, from: string): string {
	const docs = s.files.filter((f) => designDoc(f.path)).map((f) => f.path);
	const specs = docs.filter((p) => /\/specs\//.test(p));
	const plans = docs.filter((p) => /\/plans\//.test(p));
	const what = plans.length && specs.length ? "a design doc and its implementation plan" : plans.length ? "an implementation plan" : specs.length ? "a design doc" : "documentation";
	return [
		"[Review scope, set by pi-guard. Follow it exactly.]",
		`This is a review of ${what}, not of code: the diff changes no source file. App: ${s.dir} (your working directory). Its AGENTS.md, if it has one, is already in your context.`,
		`Diff: ${s.diffPath}, every change from ${from} to the current working tree.`,
		`Changed files:\n${files}`,
		"Read the diff first, then open the source files the document names and check what it says about them. Don't run anything; don't read config, CI, lock, test-result, coverage or git files.",
		"Report, each with path:line evidence:",
		"- A claim about the code that is false: a file, function, type, field or behaviour the document names that is not there or does not work as described, and a section of docs/spec.md it renumbers or contradicts.",
		...(plans.length
			? [
					"- A hole between plan and spec: a goal, behaviour or decision in the spec that no task implements or tests; a task whose interfaces, files or test names don't match the spec or each other; an ordering that makes a task's tests impossible when it runs.",
					"- A step a worker cannot follow as written: an ambiguous file choice, a garbled rule, a regex or formula that can't do what the step claims.",
				]
			: ["- A decision the doc leaves open that the plan or the code will have to make, and a non-goal that contradicts a goal."]),
		`Put independent reads in one turn. You have ${REVIEW_BUDGET.hard} tool calls; at ${REVIEW_BUDGET.soft} write your review.`,
		...(s.request ? ["", "[Michael's request, verbatim. The parent's summary below may have lost part of it.]", s.request, "", "Check that the document answers what Michael asked for, point by point; a point it drops or contradicts is a P1 finding and the merge verdict is BLOCK."] : []),
		...(s.inputs?.length
			? [
					"",
					`Michael's file: ${s.inputs.join(", ")}. Open it. Every rule the document states about how such a file is read (what an entry means, which entries count, what a value becomes) is checked against the file's own entries and what they mean in that format; a rule the file contradicts is a P1 and the merge verdict is BLOCK. Name the entries you checked.`,
				]
			: []),
		"",
		"[The parent's request]",
	].join("\n");
}

/** The paragraph that makes Michael's file the oracle of a code review. Keeb PR #31 (2026-11-17): every test the
 *  reviewer cited passed, and their expected values were the code's own output (`7 · Sym` for a key that types `&`);
 *  the spec supplied the same wrong rule. Only running the file through the code showed it. */
function inputsOracle(inputs: string[]): string {
	return `Michael's file: ${inputs.join(", ")}. It is the oracle, above docs/spec.md and above the tests. Open it, pick ten entries the change reads (spread over its sections, the odd ones included), and for each write down what the entry means in its own format, then check that against the value a test expects for it, or against the fixture copied from it. An expected value that repeats the code's output, or that you cannot derive from the entry without running the code, is a P1 finding and the merge verdict is BLOCK. Where docs/spec.md and the file disagree about what an entry means, the file wins and the spec line is a P1. Name the ten entries and what you found for each in your review.`;
}

/** The text of Michael's last message on the branch, verbatim, cut at `max` characters; undefined when there is none. */
export function lastRequest(branch: Iterable<unknown>, max = 2000): string | undefined {
	let text: string | undefined;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type !== "message" || e.message?.role !== "user") continue;
		const c = e.message.content;
		const t = typeof c === "string" ? c : Array.isArray(c) ? (c as { type?: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") : "";
		const trimmed = t.trim();
		if (trimmed) text = trimmed;
	}
	if (text === undefined) return undefined;
	return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

// The shell commands and Python code a tool call would run, for bash and context-mode's ctx_* tools.
export function codeOf(toolName: string, input: Record<string, unknown>): { shell: string[]; python: string[] } {
	const str = (v: unknown) => (typeof v === "string" ? [v] : []);
	if (toolName === "bash" || toolName === "bg_bash") return { shell: str(input.command), python: [] };
	if (toolName === "ctx_execute") {
		if (input.language === "shell") return { shell: str(input.code), python: [] };
		if (input.language === "python") return { shell: [], python: str(input.code) };
	}
	if (toolName === "ctx_batch_execute" && Array.isArray(input.commands)) {
		return { shell: input.commands.flatMap((c) => str((c as { command?: unknown })?.command)), python: [] };
	}
	return { shell: [], python: [] };
}

const SKILL_PUSH = /thatsit-app\.ts\s+(?:pr|ship|gateway-pr)\b(?!-wait)/;
const PR_OPEN = /thatsit-app\.ts\s+(?:pr|gateway-pr)\b(?!-wait)/;
const CI_WAIT = /thatsit-app\.ts\s+(?:pr-wait|gateway-pr-wait|ship)\b/;

export function checkToolCall(toolName: string, input: Record<string, unknown>, env: Env): Block | undefined {
	if (toolName === "bash") {
		const command = String(input.command ?? "");
		// pr and gateway-pr return in seconds, so a timeout means the model thinks it waits.
		if (typeof input.timeout === "number" && PR_OPEN.test(command)) return { block: true, reason: REASONS.prTimeout };
		// Waiting on CI belongs to bg_bash, whether or not the command is backgrounded.
		if (CI_WAIT.test(command)) return { block: true, reason: REASONS.waitInBackground };
	}
	const { shell, python } = codeOf(toolName, input);
	for (const command of shell) {
		const v = checkShell(command, env);
		if (v) return v;
	}
	if (python.some((code) => pythonRewrite(code) && appDir(code, env.cwd, env.home))) return { block: true, reason: REASONS.rewrite };
	if (env.orchestrator && (toolName === "edit" || toolName === "write") && typeof input.path === "string" && appCodePath(input.path, env.cwd, env.home)) {
		return { block: true, reason: REASONS.orchestrator };
	}
	if (toolName === "write" && typeof input.path === "string") return checkOverwrite(input.path, env);
	return undefined;
}

export const OVERWRITE_LINES = 80;

// A whole-file write over a long existing app file, blocked once per path.
function checkOverwrite(raw: string, env: Env): Block | undefined {
	if (!env.lines || !env.rewrites) return undefined;
	const expanded = raw.replace(/^~(?=\/)/, env.home);
	const path = isAbsolute(expanded) ? expanded : join(env.cwd, expanded);
	if (!path.startsWith(`${join(env.home, "workspace", "apps")}/`)) return undefined;
	if ((env.lines(path) ?? 0) <= OVERWRITE_LINES || env.rewrites.has(path)) return undefined;
	env.rewrites.add(path);
	return { block: true, reason: REASONS.overwrite };
}

// --- stalled turns ---

type Msg = { role: string; stopReason?: string; content?: unknown; customType?: string; toolName?: string; details?: unknown };

export const NUDGE_TYPE = "pi-guard-nudge";
export const MAX_NUDGES = 2;
// Every real end-of-turn reply in the keeb session was 381+ characters; every stall was empty or ~150.
export const SHORT_REPLY = 250;
export const NUDGE =
	"Your turn ended without a reply to Michael. If the task is finished, write your final reply now, here in the chat (not in memory or a file). If it is not finished, continue with the next step now. If you are blocked or need a decision, ask one question.";

const parts = (m: Msg): { type: string; text?: string; name?: string }[] => (Array.isArray(m.content) ? m.content : []);
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : parts(m).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"));

// The run started a bg_bash job whose bg-bash-done message has not arrived: ending the turn is the plan, and
// the done message starts the next one.
export function waitingOnBgJob(run: Msg[]): boolean {
	const open = new Set<string>();
	for (const m of run) {
		if (m.role === "toolResult" && m.toolName === "bg_bash") {
			const d = m.details as { id?: unknown } | undefined;
			const id = /started job (bg-\d+)/.exec(textOf(m))?.[1] ?? (typeof d?.id === "string" ? d.id : undefined);
			if (id) open.add(id);
		} else if (m.role === "custom" && m.customType === "bg-bash-done") {
			const id = /^bg_bash job (bg-\d+) /.exec(textOf(m))?.[1];
			if (id) open.delete(id);
		}
	}
	return open.size > 0;
}

// The run launched (or revived) an async subagent run whose subagent-notify message has not arrived: same plan, the
// orchestrator ends its turn and pi-subagents wakes it with the result (keeb runs 2026-11-12, nudged while the worker ran).
// The notice names the run's directory, so its id is matched anywhere in the text; a sync launch opens nothing.
export function waitingOnAsyncRun(run: Msg[]): boolean {
	const open = new Set<string>();
	for (const m of run) {
		if (m.role === "toolResult" && m.toolName === "subagent") {
			const text = textOf(m);
			const d = m.details as { asyncId?: unknown } | undefined;
			const id = /Async: \S+ \[([0-9a-f-]{36})\]/.exec(text)?.[1] ?? /Revived run: ([0-9a-f-]{36})/.exec(text)?.[1] ?? (typeof d?.asyncId === "string" ? d.asyncId : undefined);
			if (id) open.add(id);
		} else if (m.role === "custom" && m.customType === "subagent-notify") {
			for (const id of [...open]) if (textOf(m).includes(id)) open.delete(id);
		}
	}
	return open.size > 0;
}

const waitingOnBackground = (run: Msg[]) => waitingOnBgJob(run) || waitingOnAsyncRun(run);

// The reply puts a question to Michael: a sentence of prose ends in "?" (markdown emphasis and closing
// brackets aside; "a?.b" or "?q=" don't count). pi-web replies close with a "TL;DR:" line, so the question is rarely the last character.
// Code blocks and quotes don't count.
export function asksUser(text: string): boolean {
	let fenced = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (fenced || line.startsWith(">")) continue;
		if (/\?[*_`)\]"'”’]*(\s|$)/.test(line)) return true;
	}
	return false;
}

// A coding run (it edited or wrote a file) that ended right after a tool result with a short statement.
export function shouldNudge(messages: Msg[]): boolean {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	if (waitingOnBackground(run)) return false;
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (run.at(-2)?.role !== "toolResult") return false;
	const coded = run.some((m) => m.role === "assistant" && parts(m).some((p) => p.type === "toolCall" && (p.name === "edit" || p.name === "write")));
	if (!coded) return false;
	if (run.filter((m) => m.role === "custom" && m.customType === NUDGE_TYPE).length >= MAX_NUDGES) return false;
	// Once sent back to tidy the to-do list, a short "list updated" reply is the expected answer.
	if (run.some((m) => m.role === "custom" && m.customType === TODO_NUDGE_TYPE)) return false;
	const text = textOf(last).trim();
	return text.length < SHORT_REPLY && !asksUser(text);
}

// --- open to-dos at the end of a run ---

export type Todo = { id: number; subject: string; status: string };

export const TODO_NUDGE_TYPE = "pi-guard-todos";
export const MAX_TODO_NUDGES = 2;
const OPEN = new Set(["in_progress", "pending"]);

// The to-do list as rpiv-todo rebuilds it: the last `todo` tool result on the session branch wins.
export function openTodos(branch: Iterable<unknown>): Todo[] {
	let tasks: Todo[] = [];
	for (const entry of branch) {
		const msg = (entry as { type?: string; message?: { role?: string; toolName?: string; details?: { tasks?: unknown } } }).message;
		if ((entry as { type?: string }).type !== "message" || msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (Array.isArray(msg.details?.tasks)) tasks = msg.details.tasks as Todo[];
	}
	return tasks.filter((t) => OPEN.has(t.status));
}

// A run that did work (edited, wrote or used the todo tool) ended with a reply, not a question, while to-dos are open.
export function shouldNudgeTodos(messages: Msg[], open: Todo[]): boolean {
	if (!open.length) return false;
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	if (waitingOnBackground(run)) return false;
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (asksUser(textOf(last))) return false;
	const worked = run.some((m) => m.role === "assistant" && parts(m).some((p) => p.type === "toolCall" && (p.name === "edit" || p.name === "write" || p.name === "todo")));
	if (!worked) return false;
	return run.filter((m) => m.role === "custom" && m.customType === TODO_NUDGE_TYPE).length < MAX_TODO_NUDGES;
}

export function todoNudge(open: Todo[]): string {
	const items = open.map((t) => `- #${t.id} ${t.subject} (${t.status === "in_progress" ? "in progress" : "pending"})`).join("\n");
	return `Before you finish: your to-do list still has ${open.length} open item${open.length === 1 ? "" : "s"}:\n${items}\nUpdate it now with the todo tool: mark each finished item completed, and delete items that no longer apply. If an item is really unfinished, keep working on it, or say in your reply what is left.`;
}

// --- an app changed without a PR ---

export const PR_NUDGE_TYPE = "pi-guard-pr";
export const MAX_PR_NUDGES = 2;

type Call = { type: string; name?: string; arguments?: Record<string, unknown> };

// Apps this prompt's run edited or wrote with no pr/ship/gateway-pr after the last such edit, that still have work
// to publish (needsPr: uncommitted changes, unpushed commits, or a branch never pushed).
export function appsNeedingPr(messages: Msg[], home: string, needsPr: (dir: string) => boolean): string[] {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const lastEdit = new Map<string, number>();
	let lastPush = -1;
	messages.slice(start).forEach((m, i) => {
		if (m.role !== "assistant") return;
		for (const c of parts(m) as Call[]) {
			if (c.type !== "toolCall") continue;
			if ((c.name === "edit" || c.name === "write") && typeof c.arguments?.path === "string") {
				const dir = appDir(c.arguments.path, "", home);
				if (dir) lastEdit.set(dir, i);
			}
			if ((c.name === "bash" || c.name === "bg_bash") && SKILL_PUSH.test(String(c.arguments?.command ?? ""))) lastPush = i;
		}
	});
	return [...lastEdit].filter(([, i]) => i > lastPush).map(([dir]) => dir).filter(needsPr);
}

/** The same for any other git repo under ~/workspace: edited or written this run, with no `git push` or `gh pr create`
 *  naming it (by path or cwd) after the last edit, and work still to publish. `repoRoot` maps a path to its repo. */
export function reposNeedingPr(messages: Msg[], cwd: string, home: string, repoRoot: (path: string) => string | undefined, needsPr: (dir: string) => boolean): string[] {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const lastEdit = new Map<string, number>();
	const lastPush = new Map<string, number>();
	messages.slice(start).forEach((m, i) => {
		if (m.role !== "assistant") return;
		for (const c of parts(m) as Call[]) {
			if (c.type !== "toolCall") continue;
			if ((c.name === "edit" || c.name === "write") && typeof c.arguments?.path === "string") {
				const at = workspacePath(c.arguments.path, cwd, home);
				const dir = at ? repoRoot(at) : undefined;
				if (dir) lastEdit.set(dir, i);
			}
			const command = String(c.arguments?.command ?? "");
			if ((c.name === "bash" || c.name === "bg_bash") && PUBLISHES.test(command)) {
				const at = workspacePath(command, cwd, home);
				const dir = at ? repoRoot(at) : undefined;
				if (dir) lastPush.set(dir, i);
			}
		}
	});
	return [...lastEdit].filter(([dir, i]) => i > (lastPush.get(dir) ?? -1)).map(([dir]) => dir).filter(needsPr);
}

export function repoPrNudge(repos: string[]): string {
	const name = (d: string) => d.split("/").pop();
	return `You changed ${repos.map(name).join(" and ")} but did not push it or open its pull request. Do it yourself now; never hand Michael commands to run. If you are on the trunk (main or master), first create a branch (git switch -c <short-name>). Commit, call the reviewer (the guard scopes it to the repo; the push is blocked until a review finished), then push and open the PR in the repo:\ngit push -u origin <branch>\ngh pr create --title "<short title>" --body "<what and why>"\nThen tell Michael the PR link and end your turn. Michael merges the PR; never merge or close it yourself, and don't suggest a merge command. If Michael said not to open a PR, say so in one line instead.`;
}

export function shouldNudgePr(messages: Msg[], apps: string[]): boolean {
	if (!apps.length) return false;
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	if (waitingOnBackground(run)) return false;
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (asksUser(textOf(last))) return false;
	return run.filter((m) => m.role === "custom" && m.customType === PR_NUDGE_TYPE).length < MAX_PR_NUDGES;
}

export function prNudge(apps: string[]): string {
	const name = (d: string) => d.split("/").pop();
	const cmds = apps.map((d) => `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/${name(d)} --title "<short title>" --body "<what and why>"`).join("\n");
	const waitCmds = apps.map((d) => `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr-wait ~/workspace/apps/${name(d)}`).join("\n");
	return `You changed ${apps.map(name).join(" and ")} but did not open or update its pull request. Do it yourself now; never hand Michael commands to run. If you are on main, or on a branch whose PR is already merged, first create a new branch from main (git switch -c <short-name>). Commit, then run pr:\n${cmds}\nThen wait for CI with the bg_bash tool (never bash), tell Michael the PR link and end your turn:\n${waitCmds}\nMichael merges the PR; never merge or close it yourself, and don't suggest a merge command. If Michael said not to open a PR, say so in one line instead.`;
}

// --- a reply that hands Michael a merge command ---

export const MERGE_NUDGE_TYPE = "pi-guard-merge";
export const MERGE_NUDGE =
	"Your reply tells Michael to merge or close the pull request, or hands him the command for it. Michael merges on his own, in his own time: write the reply again without the merge or close command and without asking him to merge. Give him the PR link and the preview link and say whether CI is green.";

// The command rule's text form: `gh pr merge` / `gh pr close`, inline or in a code block, or a plain instruction to
// merge (the website session 2026-11-19: the guard blocked `gh pr merge 2 --merge --admin`, and seven minutes later
// the reply told Michael "Run this ... gh pr merge 2 --merge").
const MERGE_TEXT = /\bgh\s+pr\s+(?:merge|close)\b|\bgit\s+merge\s+\S+/i;
const MERGE_ASK = /\b(?:run|execute)\s+(?:the\s+)?merge\b|\bmerge\s+(?:it|this|the\s+pr|pr\s+#?\d+)\b[^.\n]*\b(?:now|please|when you can|to ship)\b|\bonly your merge remains\b|\bawaits your merge\b/i;

/** True when the reply text carries a merge/close command or tells Michael to merge. */
export function suggestsMerge(text: string): boolean {
	return MERGE_TEXT.test(text) || MERGE_ASK.test(text);
}

// The run ended on a reply that suggests a merge: sent back once, whatever else the run did (a reply alone can break
// this rule).
export function shouldNudgeMerge(messages: Msg[]): boolean {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (run.some((m) => m.role === "custom" && m.customType === MERGE_NUDGE_TYPE)) return false;
	return suggestsMerge(textOf(last));
}

// Compaction. Some extensions inject their rules as a message at session start and again after every
// compaction (i-have-adhd). pi's summarizer reads that message as the user's first request and makes it the
// summary's goal, so the real task is lost when a compaction falls between turns. They are re-added anyway.
export const REINJECTED_TYPES: ReadonlySet<string> = new Set(["i-have-adhd-rules", "i-have-adhd-disabled"]);

/** Remove re-injected rule messages from `messages` in place; pi summarizes the same array after the hook. */
export function dropReinjected(messages: unknown[] | undefined): void {
	if (!messages) return;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i] as { role?: string; customType?: string };
		if (m?.role === "custom" && REINJECTED_TYPES.has(m.customType ?? "")) messages.splice(i, 1);
	}
}

// --- a questionnaire closed partway ---

type Answer = { questionIndex?: number; question?: string; kind?: string; answer?: string | null; selected?: string[] };

// rpiv-ask-user-question reports any cancelled questionnaire as "User declined to answer questions" and keeps
// the answers given before the cancel in `details`, which the model never sees. Returns the text the model
// should get instead, or undefined when there is nothing to recover (a plain decline, or a full answer).
export function partialAnswers(input: { questions?: { question?: string }[] } | undefined, details: unknown): string | undefined {
	const d = details as { cancelled?: boolean; answers?: Answer[] } | undefined;
	if (!d?.cancelled || !d.answers?.length) return undefined;
	const questions = input?.questions ?? [];
	const total = Math.max(questions.length, d.answers.length);
	const given = d.answers.map((a) => `"${a.question ?? ""}"="${a.kind === "multi" ? (a.selected ?? []).join(", ") : (a.answer ?? "")}"`).join(" ");
	const done = new Set(d.answers.map((a) => a.questionIndex));
	const open = questions.map((q, i) => (done.has(i) ? null : `"${q.question ?? ""}"`)).filter(Boolean);
	return `The user answered ${d.answers.length} of ${total} questions, then closed the questionnaire: ${given} Use these answers.${open.length ? ` Not answered: ${open.join(", ")}.` : ""} Closing it is not a preference about how you ask: keep the same format, and ask what is still open again if you need it.`;
}

// --- A follow-up a `stop` withdrew. A resume appends its message to the worker's session file and a stop ends the run,
// but the message stays: the next resume on that worker reads it as open work (fret 2026-11-14: the orchestrator sent
// "remove the dialog border" at 19:33:28, Michael's "the dialog border is ok" stopped the run 45 s later, and at 20:02
// the next resume on the same worker removed the border anyway). The first resume after the stop says it was withdrawn. ---

const ASYNC_LAUNCH = /Async: \S+ \[([0-9a-f-]{36})\]/;

/** The resume messages on the worker session `resumedId` belongs to that a `stop` withdrew before the run finished and
 *  that no later resume has withdrawn yet. Runs form a chain: a launch, then each resume revives the chain under a new id. */
export function withdrawnFollowUps(branch: Iterable<unknown>, resumedId: string): string[] {
	const chain = new Map<string, string>(); // run id -> the chain's first run id
	const chainOf = (id: string) => {
		const key = [...chain.keys()].find((k) => k === id || k.startsWith(id));
		return key ? chain.get(key) : undefined;
	};
	const launches = new Set<string>(); // tool call ids
	const resumes = new Map<string, { id: string; message: string }>(); // tool call id -> the resume
	const revived = new Map<string, string>(); // revived run id -> the resume message that revived it
	const finished = new Set<string>(); // run ids a subagent-notify reported done (not stopped)
	const withdrawn = new Map<string, string[]>(); // chain -> withdrawn messages not yet noted
	for (const raw of branch) {
		const e = raw as Entry & { customType?: string; content?: unknown };
		if (e.type === "custom_message" && e.customType === "subagent-notify") {
			const text = typeof e.content === "string" ? e.content : Array.isArray(e.content) ? (e.content as { text?: string }[]).map((p) => p.text ?? "").join("\n") : "";
			if (!/\bstopped\b/i.test(text)) for (const id of revived.keys()) if (text.includes(id)) finished.add(id);
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content as ToolCallPart[]) {
				if (c.type !== "toolCall" || c.name !== "subagent" || !c.id) continue;
				const a = c.arguments ?? {};
				if (a.action === "resume" && typeof a.id === "string") {
					resumes.set(c.id, { id: a.id, message: String(a.message ?? "") });
					const ch = chainOf(a.id);
					if (ch) withdrawn.delete(ch); // this resume carried the note (or came before the fix: nothing to add now)
				} else if (a.action === "stop" && typeof a.id === "string") {
					const id = [...revived.keys()].find((k) => k === a.id || k.startsWith(String(a.id)));
					if (!id || finished.has(id)) continue;
					const ch = chainOf(id) ?? id;
					withdrawn.set(ch, [...(withdrawn.get(ch) ?? []), revived.get(id) ?? ""]);
				} else if (a.action === undefined) {
					launches.add(c.id);
				}
			}
		} else if (m.role === "toolResult" && m.toolCallId && !m.isError) {
			const text = resultText(m);
			if (launches.has(m.toolCallId)) {
				const id = ASYNC_LAUNCH.exec(text)?.[1];
				if (id) chain.set(id, id);
			}
			const res = resumes.get(m.toolCallId);
			const id = res && REVIVED_RUN.exec(text)?.[1];
			if (res && id) {
				chain.set(id, chainOf(res.id) ?? id);
				revived.set(id, res.message);
			}
		}
	}
	const ch = chainOf(resumedId);
	return ch ? (withdrawn.get(ch) ?? []).filter(Boolean) : [];
}

const firstLine = (s: string, max: number) => {
	const line = s.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
};

export const withdrawnNote = (messages: string[]) => `[pi-guard] Michael stopped your previous run before it finished, which withdraws the follow-up it carried: ${messages.map((m) => `"${firstLine(m, 160)}"`).join("; ")}. Do not act on it and undo nothing for it; the message below is the whole of what is wanted now.`;

/** Prepends the withdrawal note to a resume's message when its worker session holds a stopped follow-up; true when it did. */
export function noteWithdrawn(input: Record<string, unknown>, branch: Iterable<unknown>): boolean {
	if (input.action !== "resume" || typeof input.id !== "string") return false;
	const messages = withdrawnFollowUps(branch, input.id);
	if (!messages.length) return false;
	input.message = `${withdrawnNote(messages)}\n\n${String(input.message ?? "")}`;
	return true;
}

// --- The request each turn sends, digested. A prefix-cache miss on the 27b costs 2–3 min (fret 2026-11-14: 8 cold
// prefills, 18 of 55 orchestrator minutes); the server log shows the miss, not its cause. Hashes of the system prompt
// and of each message say whether the request changed before its last message, and where. ---

export type PromptDigest = { model?: string; sys: string; msgs: string[]; chars: number };

/** Hashes of a provider payload: the system text (any `system`/`instructions` field and system-role messages) and each
 *  other message in order; undefined when the payload carries no message list. */
export function promptDigest(payload: unknown): PromptDigest | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as { model?: unknown; system?: unknown; instructions?: unknown; messages?: unknown; input?: unknown };
	const list = Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : undefined;
	if (!list) return undefined;
	const role = (m: unknown) => (m && typeof m === "object" ? (m as { role?: unknown }).role : undefined);
	const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v) ?? "").digest("hex").slice(0, 10);
	const system = [p.system, p.instructions, ...list.filter((m) => role(m) === "system")].filter((v) => v !== undefined);
	return { model: typeof p.model === "string" ? p.model : undefined, sys: h(system), msgs: list.filter((m) => role(m) !== "system").map(h), chars: JSON.stringify(payload).length };
}
