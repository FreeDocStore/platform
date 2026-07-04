// End-to-end nav change on a MkDocs site: update_nav_config must target
// mkdocs.yml (not docs/nav.json), rewrite only its nav: block, and Apply must
// PUT mkdocs.yml. Plus the security invariant: edit_file still can't touch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

function installChromeMock() {
  const store = new Map();
  const area = (m) => ({
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    get: async (key) => {
      if (key == null) return Object.fromEntries(m); // list-all (proposal prune)
      const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
      const v = m.get(k);
      return v === undefined ? {} : { [k]: v };
    },
    remove: async (key) => { m.delete(typeof key === "string" ? key : key[0]); },
  });
  globalThis.chrome = { storage: { session: area(store), local: area(new Map()) } };
}
installChromeMock();

const { buildNavProposalPreview, applyPendingProposal } =
  await import(await bundle("src/adapters/openai.ts"));
const { loadPendingProposal } = await import(await bundle("src/lib/proposals.ts"));
const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
const { isValidReadPath } = await import(await bundle("src/adapters/openai-tools.ts"));

const b64 = (s) => Buffer.from(s).toString("base64");
const MKDOCS = `site_name: Test KB\ndocs_dir: docs\n\nnav:\n  - Home: index.md\n  - Operations: operations.md\n\nextra:\n  generator: false\n`;

function installFetchMock(mapping) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", init });
    const path = String(url).replace(/^https:\/\/api\.github\.com/, "").split("?")[0];
    const handler = mapping[`${init.method ?? "GET"} ${path}`];
    if (!handler) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const { status = 200, body } = handler({ ...init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const SETTINGS = { adapter: "openai", claude: { apiKey: "", model: "", githubToken: "ghp_test" } };
const navProposal = {
  items: [
    { label: "Home", href: "index.md" },
    { label: "Operations", href: "operations.md" },
    { label: "Credits", href: "credits.md" },
  ],
  summary: "Add Credits to the site menu",
};

test("update_nav_config on a MkDocs site targets mkdocs.yml and rewrites its nav block", async () => {
  const { restore } = installFetchMock({
    // resolveNavTarget: nav.json missing, mkdocs.yml present.
    "GET /repos/o/r/contents/docs/nav.json": () => ({ status: 404, body: { message: "Not Found" } }),
    "GET /repos/o/r/contents/mkdocs.yml": () => ({ body: { content: b64(MKDOCS), sha: "ymlsha", path: "mkdocs.yml", encoding: "base64" } }),
  });
  try {
    const gh = await GitHubClient.fromSettings(SETTINGS);
    const reply = await buildNavProposalPreview(gh, "o", "r", navProposal, "direct");
    assert.equal(reply.attachment?.kind, "preview");
    const p = reply.attachment.data;
    assert.equal(p.kind, "nav");
    assert.equal(p.path, "mkdocs.yml", "must target mkdocs.yml, not docs/nav.json");
    assert.match(p.newContent, /  - Credits: credits\.md/, "adds the Credits nav entry");
    assert.match(p.newContent, /site_name: Test KB/, "preserves the rest of the file");
    assert.match(p.newContent, /extra:\n  generator: false/, "preserves content after nav:");
    assert.match(reply.content, /Proposed change to mkdocs\.yml/);
  } finally {
    restore();
  }
});

test("applying the MkDocs nav proposal PUTs mkdocs.yml", async () => {
  const { calls, restore } = installFetchMock({
    "GET /repos/o/r/contents/docs/nav.json": () => ({ status: 404, body: {} }),
    "GET /repos/o/r/contents/mkdocs.yml": () => ({ body: { content: b64(MKDOCS), sha: "ymlsha", path: "mkdocs.yml", encoding: "base64" } }),
    "GET /repos/o/r": () => ({ body: { default_branch: "main" } }),
    "GET /repos/o/r/git/ref/heads/main": () => ({ body: { object: { sha: "basesha" } } }),
    "PUT /repos/o/r/contents/mkdocs.yml": () => ({ body: { commit: { sha: "newsha", html_url: "https://github.com/o/r/commit/newsha" } } }),
  });
  try {
    const gh = await GitHubClient.fromSettings(SETTINGS);
    const reply = await buildNavProposalPreview(gh, "o", "r", navProposal, "direct");
    const stored = await loadPendingProposal(reply.attachment.data.proposalId);
    const result = await applyPendingProposal(stored, gh);
    assert.match(result.content, /Pushed|commit/i);
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, "apply must PUT");
    assert.match(put.url, /contents\/mkdocs\.yml/, "writes mkdocs.yml");
    const body = JSON.parse(put.init.body);
    assert.equal(Buffer.from(body.content, "base64").toString("utf8").includes("- Credits: credits.md"), true);
    assert.equal(body.sha, "ymlsha", "uses the mkdocs.yml sha");
  } finally {
    restore();
  }
});

test("SECURITY: edit_file/create_page still cannot target mkdocs.yml", () => {
  // The write clamp that keeps a hostile page from steering commits into config
  // must remain: only the nav builder (server-chosen target) writes mkdocs.yml.
  assert.equal(isValidReadPath("mkdocs.yml"), false);
  assert.equal(isValidReadPath("docs/credits.md"), true);
  assert.equal(isValidReadPath(".github/workflows/deploy.yml"), false);
});

test("mkdocs nav: an invalid nav shape is refused, not silently dropped or crashed", async () => {
  // Regression: before the shape check the mkdocs branch fed proposal.items
  // straight to serializeMkdocsNav, which silently dropped an item with neither
  // href nor children and threw a raw TypeError on a child with no href. It must
  // now validate via parseNavConfig (same as the nav.json branch) and return a
  // plain error message - no throw, no partial write.
  const { restore } = installFetchMock({
    "GET /repos/o/r/contents/docs/nav.json": () => ({ status: 404, body: { message: "Not Found" } }),
    "GET /repos/o/r/contents/mkdocs.yml": () => ({ body: { content: b64(MKDOCS), sha: "ymlsha", path: "mkdocs.yml", encoding: "base64" } }),
  });
  try {
    const gh = await GitHubClient.fromSettings(SETTINGS);
    const bad = { summary: "broken", items: [{ label: "Docs", children: [{ label: "No href here" }] }] };
    const reply = await buildNavProposalPreview(gh, "o", "r", bad, "direct");
    assert.equal(reply.attachment, undefined, "no preview - it must refuse");
    assert.match(reply.content, /invalid nav shape/i);
  } finally {
    restore();
  }
});

test("buildNavProposalPreview creates docs/nav.json when the repo has NO nav config (no crash)", async () => {
  // Neither docs/nav.json nor mkdocs.yml/.yaml exists -> every contents GET
  // 404s (empty mapping). Must NOT throw on gh.getFile; instead propose
  // creating docs/nav.json with a null sha.
  const { restore } = installFetchMock({});
  try {
    const gh = await GitHubClient.fromSettings(SETTINGS);
    const reply = await buildNavProposalPreview(gh, "o", "r", navProposal, "direct");
    assert.equal(reply.attachment?.kind, "preview", "produces a preview, not an error/throw");
    const p = reply.attachment.data;
    assert.equal(p.kind, "nav");
    assert.equal(p.path, "docs/nav.json", "targets nav.json by default");
    assert.equal(p.fileSha, null, "null sha -> apply CREATEs the file");
    assert.equal(p.currentContent, "", "no current content for a brand-new file");
    assert.match(p.newContent, /"Credits"/, "includes the proposed items");
  } finally {
    restore();
  }
});
