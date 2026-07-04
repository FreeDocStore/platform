// mkdocs.yml nav-block surgery. This is the only writer of mkdocs.yml, so it
// must never corrupt the rest of the file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { serializeMkdocsNav, replaceMkdocsNav, applyMkdocsNav, toMkdocsPath } =
  await import(await bundle("src/lib/mkdocs-nav.ts"));

test("toMkdocsPath strips a leading docs/ (paths are docs_dir-relative)", () => {
  assert.equal(toMkdocsPath("docs/credits.md"), "credits.md");
  assert.equal(toMkdocsPath("credits.md"), "credits.md");
  assert.equal(toMkdocsPath("docs/reference/glossary.md"), "reference/glossary.md");
});

test("serializeMkdocsNav renders leaves and one-level dropdowns", () => {
  const out = serializeMkdocsNav([
    { label: "Home", href: "index.md" },
    { label: "Credits", href: "docs/credits.md" },
    { label: "Reference", children: [
      { label: "Glossary", href: "reference/glossary.md" },
      { label: "Decisions", href: "reference/decisions.md" },
    ] },
  ]);
  assert.equal(out, [
    "nav:",
    "  - Home: index.md",
    "  - Credits: credits.md",
    "  - Reference:",
    "      - Glossary: reference/glossary.md",
    "      - Decisions: reference/decisions.md",
  ].join("\n"));
});

test("serializeMkdocsNav quotes labels with YAML-special chars", () => {
  const out = serializeMkdocsNav([{ label: "Q&A: FAQ", href: "faq.md" }]);
  assert.match(out, /- "Q&A: FAQ": faq\.md/);
});

const MKDOCS = `site_name: Test KB
docs_dir: docs

theme:
  name: material

nav:
  - Home: index.md
  - Product Context: product-context.md
  - Operations: operations.md

extra:
  generator: false
`;

test("replaceMkdocsNav swaps ONLY the nav block, preserving everything else", () => {
  const items = [
    { label: "Home", href: "index.md" },
    { label: "Product Context", href: "product-context.md" },
    { label: "Operations", href: "operations.md" },
    { label: "Credits", href: "credits.md" },
  ];
  const out = replaceMkdocsNav(MKDOCS, items);
  assert.ok(out.includes("  - Credits: credits.md"), "adds the new entry");
  // Untouched surrounding content survives.
  assert.ok(out.includes("site_name: Test KB"));
  assert.ok(out.includes("theme:\n  name: material"));
  assert.ok(out.includes("extra:\n  generator: false"), "the block after nav is preserved");
  // Exactly one nav: key remains.
  assert.equal((out.match(/^nav:/gm) || []).length, 1);
  // The old three-item block is gone as a unit (no duplicate Operations line before extra).
  assert.ok(out.indexOf("Credits") < out.indexOf("extra:"), "nav stays above extra:");
});

test("replaceMkdocsNav handles a nav block at EOF", () => {
  const yml = `site_name: X\n\nnav:\n  - Home: index.md\n`;
  const out = replaceMkdocsNav(yml, [
    { label: "Home", href: "index.md" },
    { label: "Credits", href: "credits.md" },
  ]);
  assert.equal(out, `site_name: X\n\nnav:\n  - Home: index.md\n  - Credits: credits.md\n`);
});

test("replaceMkdocsNav returns null when there's no nav: key", () => {
  assert.equal(replaceMkdocsNav("site_name: X\ndocs_dir: docs\n", [{ label: "Home", href: "index.md" }]), null);
});

test("applyMkdocsNav appends a nav block when none exists", () => {
  const out = applyMkdocsNav("site_name: X\ndocs_dir: docs\n", [{ label: "Home", href: "index.md" }]);
  assert.match(out, /site_name: X/);
  assert.match(out, /\nnav:\n  - Home: index\.md\n$/);
});

test("round-trip: a no-op nav change yields identical content", () => {
  const items = [
    { label: "Home", href: "index.md" },
    { label: "Product Context", href: "product-context.md" },
    { label: "Operations", href: "operations.md" },
  ];
  assert.equal(applyMkdocsNav(MKDOCS, items), MKDOCS);
});

test("serializeMkdocsNav escapes ? and control chars so a label can't break out of nav:", () => {
  const out = serializeMkdocsNav([
    { label: "? weird", href: "a.md" },   // YAML complex-key indicator
    { label: "two\nlines", href: "b.md" }, // newline would inject a sibling key
    { label: "Q: what?", href: "c.md" },   // colon + ?
  ]);
  const lines = out.split("\n");
  // nav: + exactly one line per item — a mishandled label would add lines and
  // inject a spurious top-level key into mkdocs.yml.
  assert.equal(lines.length, 4, "each item stays on exactly one line");
  assert.match(out, /- "\? weird": a\.md/, "? label is quoted");
  assert.match(out, /- "two\\nlines": b\.md/, "newline escaped to \\n, not literal");
  assert.ok(!out.includes("two\nlines"), "no literal newline inside a label");
  assert.match(out, /- "Q: what\?": c\.md/, "colon+? label quoted");
});
