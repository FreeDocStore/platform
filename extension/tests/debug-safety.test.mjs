// Tests for the debug-bridge safety guards: loopback-only sink validation
// and token-shaped-secret scrubbing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { isLoopbackSinkUrl, scrubSecrets, redactSecrets } = await import(
  await bundle("src/lib/debug-safety.ts")
);

test("redactSecrets masks long values under secret-y keys, keeps short enums", () => {
  const fakeApiKey = ["sk", "-ant-abcdefghijklmnop"].join("");
  const out = redactSecrets({
    claude: { apiKey: fakeApiKey, githubToken: "ghp_1234567890123456" },
    sendKey: "enter", // short enum under a 'key' name - must NOT be redacted
    nested: [{ secret: "supersecretlongvalue" }],
  });
  assert.equal(out.claude.apiKey, "<redacted>");
  assert.equal(out.claude.githubToken, "<redacted>");
  assert.equal(out.sendKey, "enter");
  assert.equal(out.nested[0].secret, "<redacted>");
});

test("redactSecrets leaves non-objects untouched", () => {
  assert.equal(redactSecrets("hello"), "hello");
  assert.equal(redactSecrets(42), 42);
});

test("isLoopbackSinkUrl accepts loopback http(s) only", () => {
  assert.equal(isLoopbackSinkUrl("http://localhost:8787/event"), true);
  assert.equal(isLoopbackSinkUrl("http://127.0.0.1:8787/event"), true);
  assert.equal(isLoopbackSinkUrl("http://[::1]:8787/event"), true);
  assert.equal(isLoopbackSinkUrl("https://localhost/event"), true);
});

test("isLoopbackSinkUrl rejects remote hosts and non-http schemes", () => {
  assert.equal(isLoopbackSinkUrl("http://evil.com/event"), false);
  assert.equal(isLoopbackSinkUrl("https://collector.example.com"), false);
  // Look-alike host that merely starts with localhost must NOT pass.
  assert.equal(isLoopbackSinkUrl("http://localhost.evil.com/event"), false);
  assert.equal(isLoopbackSinkUrl("ftp://localhost/event"), false);
  assert.equal(isLoopbackSinkUrl("file:///etc/passwd"), false);
});

test("isLoopbackSinkUrl rejects empty/malformed", () => {
  assert.equal(isLoopbackSinkUrl(""), false);
  assert.equal(isLoopbackSinkUrl(undefined), false);
  assert.equal(isLoopbackSinkUrl(null), false);
  assert.equal(isLoopbackSinkUrl("not a url"), false);
});

test("scrubSecrets redacts token-shaped strings", () => {
  const fakeGithubToken = ["ghp", "_0123456789abcdefghijABCDEFGHIJ"].join("");
  const gh = scrubSecrets(`my token is ${fakeGithubToken} ok`);
  assert.ok(!gh.includes(fakeGithubToken.slice(0, 14)), "github token should be scrubbed");
  assert.match(gh, /\[redacted-secret\]/);

  assert.match(scrubSecrets(["github_pat", "_11ABCDEFG0123456789abcdefgh"].join("")), /\[redacted-secret\]/);
  assert.match(scrubSecrets(`key ${["sk", "-ant-api03-abcdefghijklmnop0123456789"].join("")}`), /\[redacted-secret\]/);
  assert.match(scrubSecrets(`openai ${["sk", "-abcdefghijklmnop0123456789ABCD"].join("")}`), /\[redacted-secret\]/);
  // Modern prefixed OpenAI keys (dashes after the prefix) must also be caught.
  const proj = scrubSecrets(`key ${["sk", "-proj-T3BlbkFJabcdefghij1234567890ABCDEFghij"].join("")} done`);
  assert.match(proj, /\[redacted-secret\]/);
  assert.doesNotMatch(proj, new RegExp(["sk", "-proj-T3Blbk"].join("")), "the raw project key must not survive");
  assert.match(scrubSecrets(["sk", "-svcacct-abcdefghij0123456789ABCDEFGH"].join("")), /\[redacted-secret\]/);
});

test("scrubSecrets leaves ordinary text untouched", () => {
  const s = "Proposed change to acme/docs · docs/index.md: add intro";
  assert.equal(scrubSecrets(s), s);
});
