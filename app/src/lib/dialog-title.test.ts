import { describe, expect, it } from "vitest";
import { choicesAnswer, parseDialogTitle } from "./dialog-title.ts";

// The exact shape @juicesharp/rpiv-ask-user-question sends for a multi-select question in RPC mode.
const MULTI =
	"[Real parts] How do the parts you design around — PCB, LED matrix, buttons — get into the model?\n\n" +
	"1. Type an envelope and hole positions (Recommended) — A component entry: bounding box, mounting holes.\n" +
	"2. Import a STEP of the real part — The kernel reads STEP.\n" +
	"3. Trace a photo with the pencil — A photo of the board sits under the sketch.\n\n" +
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';

describe("parseDialogTitle", () => {
	it("keeps a one-line title as the heading with no body", () => {
		expect(parseDialogTitle("Allow bash?")).toEqual({ heading: "Allow bash?", body: "", choices: [] });
	});

	it("uses the first line as the heading and the rest as the body", () => {
		const p = parseDialogTitle("[Housing start] What should starting a part look like?\n\nType your answer:");
		expect(p.heading).toBe("[Housing start] What should starting a part look like?");
		expect(p.body).toBe("Type your answer:");
		expect(p.choices).toEqual([]);
	});

	it("pulls a numbered option list out of the body", () => {
		const p = parseDialogTitle(MULTI);
		expect(p.heading).toBe("[Real parts] How do the parts you design around — PCB, LED matrix, buttons — get into the model?");
		expect(p.choices).toEqual([
			{ n: 1, label: "Type an envelope and hole positions (Recommended)", description: "A component entry: bounding box, mounting holes." },
			{ n: 2, label: "Import a STEP of the real part", description: "The kernel reads STEP." },
			{ n: 3, label: "Trace a photo with the pencil", description: "A photo of the board sits under the sketch." },
		]);
		// The list is gone from the body; the instructions stay.
		expect(p.body).toBe('Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.');
	});

	it("ignores a list that does not count up from 1", () => {
		const p = parseDialogTitle("Q\n\n2. a — x\n3. b — y");
		expect(p.choices).toEqual([]);
		expect(p.body).toBe("2. a — x\n3. b — y");
	});

	it("accepts options without a description", () => {
		expect(parseDialogTitle("Q\n1. a\n2. b").choices).toEqual([
			{ n: 1, label: "a", description: "" },
			{ n: 2, label: "b", description: "" },
		]);
	});
});

describe("choicesAnswer", () => {
	it("prefers typed text over picked rows", () => {
		expect(choicesAnswer([1, 3], "  like shapr3d  ")).toBe("like shapr3d");
	});
	it("sends picked numbers in order", () => {
		expect(choicesAnswer([3, 1], "")).toBe("1,3");
	});
	it("sends an empty answer when nothing is picked", () => {
		expect(choicesAnswer([], "")).toBe("");
	});
});
