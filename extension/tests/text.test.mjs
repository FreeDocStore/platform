// Tests for lib/text.ts - HTML entity decoding, title extraction, and
// the regex-based HTML-to-visible-text stripper used by read_page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const text = await import(await bundle("src/lib/text.ts"));
const { htmlToVisibleText, extractTitle } = text;

// ── htmlToVisibleText ────────────────────────────────────────────────

test("htmlToVisibleText strips script/style/nav but KEEPS header and footer", () => {
  // Regression: the model used to answer "I can't see a footer" even on
  // pages with one because we were stripping <footer>. <header> and
  // <footer> often carry real content the user asks about; <nav> is the
  // repeated topbar so it stays stripped to keep tokens down.
  const html =
    "<nav>topbar links</nav>" +
    "<header>page hero text</header>" +
    "<main><p>body</p></main>" +
    "<script>var x=1;</script><style>body{}</style>" +
    "<footer>copyright 2026, edit on github</footer>";
  const out = htmlToVisibleText(html);
  assert.equal(out, "page hero text body copyright 2026, edit on github");
});

test("htmlToVisibleText decodes named entities", () => {
  const out = htmlToVisibleText("<p>Tips &amp; Tricks &lt;x&gt; &quot;y&quot;</p>");
  assert.equal(out, 'Tips & Tricks <x> "y"');
});

test("htmlToVisibleText decodes numeric entities (regression)", () => {
  // Before the fix these stayed as raw "&#8230;" etc. in read_page output.
  const out = htmlToVisibleText("<p>Hello&#8230; see &#169;2026 &#x2014; done</p>");
  assert.equal(out, "Hello\u2026 see \u00a92026 \u2014 done");
});

test("htmlToVisibleText squeezes whitespace", () => {
  const out = htmlToVisibleText("<p>a    b\n\n\nc</p>");
  assert.equal(out, "a b c");
});

test("htmlToVisibleText: &amp; inside numeric entity is not double-decoded", () => {
  // "&amp;#8230;" should decode to "&#8230;" (single-step), not "..."
  const out = htmlToVisibleText("<p>&amp;#8230;</p>");
  assert.equal(out, "&#8230;");
});

// ── extractTitle ─────────────────────────────────────────────────────

test("extractTitle returns the title text", () => {
  assert.equal(extractTitle("<title>Components</title>"), "Components");
});

test("extractTitle decodes entities (regression)", () => {
  // Before the fix, titles shipped to the model with raw entity strings
  // like "Foo &amp; Bar" instead of "Foo & Bar".
  assert.equal(extractTitle("<title>Foo &amp; Bar</title>"), "Foo & Bar");
  assert.equal(extractTitle("<title>Tips &#8211; Tricks</title>"), "Tips \u2013 Tricks");
});

test("extractTitle handles missing title tag", () => {
  assert.equal(extractTitle("<html><body></body></html>"), "");
});

test("extractTitle handles attributes on the title tag", () => {
  assert.equal(extractTitle("<title lang=\"en\">Hello</title>"), "Hello");
});
