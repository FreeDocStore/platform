# FreeDocStore agent instructions

Read `CLAUDE.md` for product and architecture rules.

## Product identity

Use FreeDocStore and ProDocStore product language. Do not name unrelated source
products or describe cross-product provenance in source, documentation, tests,
fixtures, paths, issues, commit messages or release notes. Run
`npm run check:identity` before committing. Keep test fixtures and the naming
check itself free of prohibited literals.

Run `npm run setup:hooks` once per clone to install the staged-file and
commit-message checks. These complement the CI check that runs on every push
and pull request.

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

Commit directly to `main`. Do not run `git checkout -b`, `git switch -c`, or
`gh pr create`. If on a non-`main` branch, stop and report it.
