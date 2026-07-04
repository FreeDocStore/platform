// Tests for @mention parsing/merging used by team-collab task attribution.
// Pure logic, no DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { parseMentions, mergeMentions } = await import(await bundle("src/lib/mentions.ts"));

test("parseMentions: pulls distinct lowercased logins in first-seen order", () => {
  assert.deepEqual(parseMentions("hey @Alice and @bob, ping @alice again"), ["alice", "bob"]);
});

test("parseMentions: none returns empty", () => {
  assert.deepEqual(parseMentions("just a normal edit request"), []);
});

test("parseMentions: ignores mid-word @ (emails)", () => {
  assert.deepEqual(parseMentions("mail me at user@example.com"), []);
});

test("parseMentions: handles start-of-string and hyphenated logins", () => {
  assert.deepEqual(parseMentions("@octo-cat please review"), ["octo-cat"]);
});

test("parseMentions: rejects trailing hyphen (stops before it)", () => {
  // GitHub logins can't end in a hyphen; the regex captures up to the last
  // alphanumeric, so "@foo-" yields "foo".
  assert.deepEqual(parseMentions("@foo- done"), ["foo"]);
});

test("mergeMentions: unions preserving order, no duplicates", () => {
  assert.deepEqual(mergeMentions(["alice"], ["bob", "alice"]), ["alice", "bob"]);
});

test("mergeMentions: undefined prior treated as empty", () => {
  assert.deepEqual(mergeMentions(undefined, ["x"]), ["x"]);
});
