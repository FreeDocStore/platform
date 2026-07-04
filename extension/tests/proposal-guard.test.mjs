// Security invariant: the edit/create-page proposal builders must refuse any
// EFFECTIVE target outside docs/<name>.{html,md,mdx} - including the case where
// the model omits `path` and we fall back to context.sourcePath (derived from
// an attacker-controllable page). These refuse paths return BEFORE any storage
// or GitHub call, so no chrome/fetch mock is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { buildEditProposalPreview, buildCreatePageProposalPreview } =
  await import(await bundle("src/adapters/proposal-edit.ts"));

// gh is never touched on the refuse path; a throwing stub proves that.
const gh = new Proxy({}, { get() { throw new Error("gh must not be called on the refuse path"); } });

const editResult = (path) => ({
  kind: "edit",
  proposal: { path, edits: [{ find: "a", replace: "b" }], summary: "s" },
});

const BAD_TARGETS = [
  ".github/workflows/deploy.yml",
  "mkdocs.yml",
  "README.md",
  "../secrets.md",
  "docs/../.github/x.yml",
  "src/index.ts",
];

for (const path of BAD_TARGETS) {
  test(`edit_file refuses model-supplied non-docs target: ${path}`, async () => {
    const ctx = { url: "https://x.pages.dev", sourcePath: "docs/index.html" };
    const reply = await buildEditProposalPreview(gh, "o", "r", ctx, null, editResult(path), "direct", "prompt");
    assert.equal(reply.attachment, undefined, "no preview attachment - it must refuse");
    assert.match(reply.content, /Refusing to edit/);
  });

  test(`create_page refuses non-docs target: ${path}`, async () => {
    const ctx = { url: "https://x.pages.dev", sourcePath: "docs/index.html" };
    const reply = await buildCreatePageProposalPreview(
      "o", "r", ctx, { path, content: "x", summary: "s" }, "direct", "prompt",
    );
    assert.equal(reply.attachment, undefined, "no preview attachment - it must refuse");
    assert.match(reply.content, /Refusing to create/);
  });
}

test("edit_file refuses when path is OMITTED and context.sourcePath is non-docs", async () => {
  // The key defense-in-depth case: a spoofed page meta sets sourcePath outside
  // docs/, the model omits path, and the effective target must still be clamped.
  const ctx = { url: "https://x.pages.dev", sourcePath: ".github/workflows/deploy.yml" };
  const reply = await buildEditProposalPreview(
    gh, "o", "r", ctx, null,
    { kind: "edit", proposal: { edits: [{ find: "a", replace: "b" }], summary: "s" } },
    "direct", "prompt",
  );
  assert.equal(reply.attachment, undefined);
  assert.match(reply.content, /Refusing to edit \.github\/workflows\/deploy\.yml/);
});

test("edit_file ACCEPTS a valid docs target (proves the guard isn't blanket-refusing)", async () => {
  // A docs/ target must get PAST the guard. We can't complete without a gh/chrome
  // mock, so assert only that it does NOT hit the refuse branch - it fails later
  // trying to fetch the file, which means the path clamp let it through.
  const ctx = { url: "https://x.pages.dev", sourcePath: "docs/index.html" };
  const reply = await buildEditProposalPreview(
    gh, "o", "r", ctx, null, editResult("docs/guide.md"), "direct", "prompt",
  ).catch((e) => ({ threw: String(e) }));
  // Either it threw inside gh (past the guard) OR returned a non-refuse message.
  if (reply.threw) {
    assert.match(reply.threw, /gh must not be called/, "reached the gh fetch - guard passed");
  } else {
    assert.doesNotMatch(reply.content ?? "", /Refusing to edit/);
  }
});
