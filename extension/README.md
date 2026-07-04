# FreeDocStore browser extension

FreeDocStore is the AI-first editor for GitHub-backed public knowledge bases.
It reads a published docs page, resolves the backing repository, and lets users
ask for reviewable content proposals without adding an in-page manual editor.

The extension is AI-first. Users do not manually edit page bodies inside the
extension; they describe the desired change, review the AI proposal, and apply
it through GitHub. If a human needs to hand-edit content, they use GitHub's
file editor or normal pull request flow.

## Connecting the extension to a docs site

The extension figures out which GitHub repo backs the page you are
reading via a single meta tag on the rendered HTML:

```html
<meta name="docs-repo" content="owner/repo">
```

Decentralised by design - any docs site that wants to opt in just emits
the tag at deploy time. No registry, no per-user config, no hostname
guessing. Pages without the meta tag work in read-only mode (browse +
ask questions); commit and PR operations need a known repo.

## Quick start (dev only)

```bash
cd extension
npm install
npm run build       # writes loadable extension to dist/
npm test            # full test suite
```

Load `extension/dist/` as an unpacked extension in Chrome
(`chrome://extensions` -> Developer mode -> Load unpacked).

## Source layout

- `src/` - TypeScript source (content script, side panel, service worker,
  adapters, resolver)
- `src/resolver.ts` - URL + meta-tag -> `PageContext` (the meta-tag protocol
  lives here)
- `tests/` - Node test runner + esbuild-bundled import of the TS source
- `manifest.json` - MV3 manifest copied into `dist/` at build time
- `build.mjs` - tiny esbuild driver (no webpack/rollup)
- `scripts/package.mjs` - production build + zip into `dist-zip/`

## Releasing

Versions live in two places that MUST agree (the package script
enforces this and so does the release workflow):
- `extension/manifest.json` -> `version`
- `extension/package.json` -> `version`

To cut a release:

```bash
# 1. Bump both versions (e.g. 0.1.0 -> 0.1.1)
#    Use semver: PATCH for fixes, MINOR for features, MAJOR for breaking.
$EDITOR extension/manifest.json extension/package.json

# 2. Verify locally:
cd extension
npm run package    # also re-checks manifest <> package version match

# 3. Commit + tag + push
cd ..
git add extension/manifest.json extension/package.json extension/package-lock.json
git commit -m "Release v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push origin main v0.1.1
```

The `release-extension.yml` workflow fires on the tag push, runs the
full test suite, packages the zip, and creates a GitHub Release.
Failure modes (tag/manifest mismatch, test failure, missing zip) abort
BEFORE publishing - nothing leaves the repo unless every check passes.

Chrome Web Store upload is currently manual: download the zip from
the published Release and upload to
<https://chrome.google.com/webstore/devconsole>. Once we have CWS API
credentials wired into Actions secrets we can automate that step too.
