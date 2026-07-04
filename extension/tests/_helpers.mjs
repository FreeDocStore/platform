// Shared helpers for node:test files in extension/tests/.
//
// Centralises git-fixture setup and sample-site copy helpers so individual
// test files can focus on cases instead of rebuilding the same boilerplate
// (and drifting on things like GIT_CONFIG_GLOBAL - some files set it, some
// didn't, which made tests sensitive to the user's global git config).

import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
export const SCRIPTS_DIR = path.join(REPO_ROOT, "templates", "search", "scripts");
export const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures");

// Fixed committer identity + neutralise the user's global/system config
// (signing, hooks path, default branch name, etc.) so a test run is
// deterministic regardless of what's in ~/.gitconfig.
const GIT_ENV_BASE = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function gitEnv(extra) {
  return { ...process.env, ...GIT_ENV_BASE, ...(extra ?? {}) };
}

function runGit(repoPath, args, extraEnv) {
  const r = spawnSync("git", args, {
    cwd: repoPath,
    env: gitEnv(extraEnv),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return r;
}

export function initGitRepo(repoPath, remote) {
  runGit(repoPath, ["init", "-q", "-b", "main"]);
  runGit(repoPath, ["config", "user.email", "t@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  if (remote) runGit(repoPath, ["remote", "add", "origin", remote]);
}

/**
 * Commit message at `repoPath`. When `files` is null, stages everything.
 * `dateIso` sets both author + committer date for deterministic ordering
 * and timestamp assertions in tests.
 */
export function gitCommit(repoPath, message, files = null, dateIso = null) {
  const extraEnv = dateIso
    ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
    : undefined;
  if (files === null) {
    runGit(repoPath, ["add", "-A"], extraEnv);
  } else {
    runGit(repoPath, ["add", "--", ...files], extraEnv);
  }
  runGit(repoPath, ["commit", "-q", "--allow-empty", "-m", message], extraEnv);
}

/**
 * Copy a named fixture tree (tests/fixtures/<name>/) into a fresh tmpdir.
 * Returns { root, site, cleanup } where `root` is the tmpdir containing
 * a copy of <name>/ and `site` is the copy itself.
 */
export function copyFixture(name) {
  const root = mkdtempSync(path.join(tmpdir(), `fx-${name}-`));
  const site = path.join(root, name);
  cpSync(path.join(FIXTURES_DIR, name), site, { recursive: true });
  return {
    root,
    site,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Copy sample_site into a tmpdir with docs/ at the repo root. Mirrors the
 * pytest `sample_site` fixture so CLI tests can use `--repo <root>`.
 */
export function makeSampleSite() {
  const root = mkdtempSync(path.join(tmpdir(), "sample-site-"));
  cpSync(path.join(FIXTURES_DIR, "sample_site"), root, { recursive: true });
  return {
    root,
    docs: path.join(root, "docs"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Empty throwaway directory. For tests that build their own tree. */
export function mkdtempBare(prefix = "test-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
