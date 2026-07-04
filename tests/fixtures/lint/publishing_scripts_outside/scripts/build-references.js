// Fixture: a publishing script (per-repo references builder) at the repo
// root. Lint rule #3 must flag it — the references generator lives centrally
// in docs-playbook/templates/search/scripts/generate-references.py and runs
// from the reusable workflow on every deploy.
console.log("should be flagged by docs-lint rule #3");
