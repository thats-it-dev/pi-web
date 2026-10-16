import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOption, yesNo } from "../src/answer-match.ts";

const OPTS = ["allow", "allow always", "deny"];
for (const [text, want] of [
	["allow", { kind: "match", option: "allow" }],
	[" Allow ", { kind: "match", option: "allow" }],
	["always", { kind: "match", option: "allow always" }],
	["allow al", { kind: "none" }],
	["yes", { kind: "match", option: "allow" }],
	["go ahead", { kind: "match", option: "allow" }],
	["nope", { kind: "match", option: "deny" }],
	["banana", { kind: "none" }],
	["", { kind: "none" }],
] as const) test(`matchOption(${JSON.stringify(text)})`, () => assert.deepEqual(matchOption(text, [...OPTS]), want));

test("whole-word containment: 'phone' matches 'open on phone' but 'pho' does not", () => {
	const opts = ["open on phone", "open on desktop"];
	assert.deepEqual(matchOption("phone", opts), { kind: "match", option: "open on phone" });
	assert.deepEqual(matchOption("pho", opts), { kind: "none" });
});

test("yes/no synonyms without allow/deny-shaped options give none", () => assert.deepEqual(matchOption("yes", ["red", "green"]), { kind: "none" }));

test("several options starting with the text as a whole word are ambiguous", () =>
	assert.deepEqual(matchOption("allow", ["allow once", "allow always", "deny"]), { kind: "ambiguous", options: ["allow once", "allow always"] }));

test("a bare prefix inside a word does not match", () =>
	assert.deepEqual(matchOption("all", ["allow", "allow always", "deny"]), { kind: "none" }));

test("yesNo", () => {
	assert.equal(yesNo("Okay"), "yes");
	assert.equal(yesNo("don't"), "no");
	assert.equal(yesNo("maybe"), null);
});

for (const [text, options, want] of [
	["Yes.", ["yes", "no"], { kind: "match", option: "yes" }],
	["No.", ["yes", "no"], { kind: "match", option: "no" }],
	["Allow once.", ["Allow once", "Allow always", "Deny"], { kind: "match", option: "Allow once" }],
	["Go ahead.", ["Allow once", "Allow always", "Deny"], { kind: "match", option: "Allow once" }],
	["yes please", ["allow", "deny"], { kind: "match", option: "allow" }],
	["  allow   always ", ["allow", "allow always", "deny"], { kind: "match", option: "allow always" }],
	["yes", [" allow", "deny"], { kind: "match", option: " allow" }],
] as const) test(`normalised: matchOption(${JSON.stringify(text)}, ${JSON.stringify(options)})`, () => assert.deepEqual(matchOption(text, [...options]), want));

test("yesNo accepts a synonym followed by please", () => {
	assert.equal(yesNo("Yes please."), "yes");
	assert.equal(yesNo("no please"), "no");
});
