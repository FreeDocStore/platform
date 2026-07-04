// End-to-end tests for templates/search/scripts/docs-lint.sh.
//
// Each fixture under tests/fixtures/lint/ is a mini repo; the lint
// script runs with the fixture as its working directory. The script
// falls back to non-git enumeration when the fixture isn't a git repo,
// so fixtures don't need their own `git init`.
//
// Ported from tests/test_docs_lint.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, unlinkSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, REPO_ROOT, mkdtempBare } from "./_helpers.mjs";

const LINT = path.join(REPO_ROOT, "templates", "search", "scripts", "docs-lint.sh");
const LINT_FIXTURES = path.join(FIXTURES_DIR, "lint");

function copyFixture(name) {
  const { root, cleanup } = mkdtempBare("docs-lint-");
  const dest = path.join(root, name);
  cpSync(path.join(LINT_FIXTURES, name), dest, { recursive: true });
  return { dir: dest, cleanup };
}

function runLint(fixtureDir, envOverrides = {}) {
  return spawnSync("bash", [LINT], {
    cwd: fixtureDir,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
  });
}

// ── Happy path ──────────────────────────────────────────────────────

test("clean fixture passes", () => {
  const f = copyFixture("clean");
  try {
    const r = runLint(f.dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /passed/);
  } finally {
    f.cleanup();
  }
});

// ── Required fields ─────────────────────────────────────────────────

test("missing robots meta fails (FAIL, not WARN)", () => {
  const f = copyFixture("missing_robots_meta");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    // robots meta is required (FAIL); googlebot is optional (WARN only)
    assert.match(r.stdout, /FAIL: /);
    assert.match(r.stdout, /robots noindex/);
  } finally {
    f.cleanup();
  }
});

test("has deploy.yml (non-docs-deploy) fails", () => {
  const f = copyFixture("has_deploy_yml");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /deploy\.yml/);
  } finally {
    f.cleanup();
  }
});

test("tracked brand assets fails", () => {
  const f = copyFixture("tracked_brand_assets");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /styles\.css/);
    assert.match(r.stdout, /FAIL/);
  } finally {
    f.cleanup();
  }
});

// ── Opt-outs ────────────────────────────────────────────────────────

test("missing styles link fails by default", () => {
  const f = copyFixture("missing_styles_link");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /does not link styles\.css/);
  } finally {
    f.cleanup();
  }
});

test("missing styles link passes when ALLOW_INLINE_STYLES=true", () => {
  const f = copyFixture("missing_styles_link");
  try {
    const r = runLint(f.dir, { ALLOW_INLINE_STYLES: "true" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    f.cleanup();
  }
});

test("missing favicon link fails", () => {
  const f = copyFixture("missing_favicon_link");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /does not link favicon\.svg/);
  } finally {
    f.cleanup();
  }
});

test("financial content fails by default", () => {
  const f = copyFixture("financial_content");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout.toLowerCase(), /sow\.html/);
  } finally {
    f.cleanup();
  }
});

test("financial content passes when ALLOW_FINANCIAL=true", () => {
  const f = copyFixture("financial_content");
  try {
    const r = runLint(f.dir, { ALLOW_FINANCIAL: "true" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    f.cleanup();
  }
});

test("publishing scripts outside the playbook repo fail", () => {
  const f = copyFixture("publishing_scripts_outside");
  try {
    const r = runLint(f.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /generate-changelog\.py/);
    // build-references.js is also a publishing script; consumer repos
    // must not keep their own copy.
    assert.match(r.stdout, /build-references\.js/);
  } finally {
    f.cleanup();
  }
});

// ── WARN (not FAIL) ─────────────────────────────────────────────────

test("missing docs-deploy.yml warns but doesn't fail", () => {
  const f = copyFixture("clean");
  try {
    unlinkSync(path.join(f.dir, ".github", "workflows", "docs-deploy.yml"));
    const r = runLint(f.dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /WARN/);
  } finally {
    f.cleanup();
  }
});
