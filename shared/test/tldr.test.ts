import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTldr, stripTldr } from "../src/tldr.ts";

test("title and summary", () => assert.deepEqual(parseTldr("Did it.\n\nTL;DR [413 fixed]: Notes webhook 413 fixed; tests pass."), { title: "413 fixed", summary: "Notes webhook 413 fixed; tests pass." }));
test("no title", () => assert.deepEqual(parseTldr("x\nTL;DR: Merged plan 2."), { title: null, summary: "Merged plan 2." }));
test("bold and case", () => assert.equal(parseTldr("x\n**tl;dr** [a]: b")?.summary, "b"));
test("not the last line", () => assert.equal(parseTldr("TL;DR: early\nmore text"), null));
test("inside a code fence", () => assert.equal(parseTldr("```\nTL;DR: no\n```"), null));
test("twice: last wins", () => assert.equal(parseTldr("TL;DR: a\n\nTL;DR: b")?.summary, "b"));
test("empty summary is null", () => assert.equal(parseTldr("x\nTL;DR [t]:   "), null));
test("strip", () => assert.equal(stripTldr("Body.\n\nTL;DR [t]: s\n"), "Body."));
test("strip without tldr is identity", () => assert.equal(stripTldr("Body.\n"), "Body.\n"));
