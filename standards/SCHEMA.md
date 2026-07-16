# FreeDocStore Standards Registry & Composition Model

The connective tissue between the gold-standard KBs and the tools that judge code
against them. It answers one question deterministically:

> Given *this* repo, **which** gold standards should it be judged against, and at which
> edition?

An AI judge (VibeCode QA, or any agent) calls the resolver, gets back a precise set of
standards per slice, fetches those exact KB editions, and judges against them — instead
of guessing from training memory, browsing forums, or hallucinating "best practice."

## 1. The core idea: compose, don't permute

A project's standard is **not** one monolithic KB per exact stack. That path explodes
combinatorially (`framework × styling × data × hosting × backend …` = thousands of
near-duplicate KBs that drift and can't be reviewed).

Instead, a project's standard is **assembled from a small set of orthogonal KBs, applied
per slice.** Author each primitive once; get combinatorial coverage from a linear number
of KBs.

```
project standard  =  Σ over slices [ 1 archetype  +  N layers  +  cross-cutting ]  +  repo recipes
```

## 2. KB types

| Type | What it is | Cardinality | Keyed by |
| --- | --- | --- | --- |
| **archetype** | the app-shape spine of a slice | **exactly one** per slice (0 = a gap) | framework × runtime-shape |
| **layer** | a capability/tech concern plugged into a slice | zero or more per slice | a specific technology |
| **cross-cutting** | a universal dimension | auto-applied where its condition holds | a concern present in ~all code |
| **recipe** | a *blessed combo*; seam rules only, composes primitives | zero or more per **repo** | co-presence of named archetypes/layers |

Rules:

- **Exactly one archetype per slice.** Two archetypes matching one slice means the slice
  is a hybrid that must be sub-sliced (see §3), or the registry has an overlap bug.
- **Layers never stand alone.** `d1-database`, `mcp-server`, `tailwind` compose *onto* an
  archetype; they never replace it.
- **Recipes contain only the seam.** `react-spa-on-cloudflare-pages` holds the rules that
  live *between* `react-spa` and `pages-fullstack` (same-origin `/api/*`, `_routes.json`,
  secrets-in-Functions). It **references** the primitives, never re-derives them. Author a
  recipe only for combos you actively bless.

## 3. Slicing a repo

A "slice" is the unit that gets one archetype. Slicing rules:

1. **Workspace members are slices.** pnpm/npm workspace globs (`app`, `packages/*`) each
   become a slice. A non-monorepo is a single slice.
2. **Fullstack packages are split.** A package that contains both an app build *and* a
   `functions/` dir (Cloudflare Pages Functions) is split into a `frontend` sub-slice and a
   `functions` sub-slice — because a static SPA and an edge API are different archetypes
   with different rubrics, even in one folder.

This is why `~/work/crm`'s `app/` resolves to `app` → `react-spa` **and**
`app/functions` → `pages-fullstack`, not one confused verdict.

## 4. Detection DSL

Each standard carries a `detect` predicate evaluated against **signals** gathered per
slice. Signals:

- `deps` — dependency names from the slice's `package.json` (deps + devDeps)
- `files` — file paths present in the slice
- `cfg` — parsed config facts (`wrangler.toml:d1_databases`, `package.json:bin`,
  `package.json:exportsOrMain`, …)

Predicate operators (JSON, composable via `all` / `any` / `not`):

| Operator | True when |
| --- | --- |
| `{"dep": "x"}` / `{"anyDep":[…]}` / `{"noneDep":[…]}` | dependency present / any / none |
| `{"file":"x"}` / `{"anyFile":[…]}` / `{"noneFile":…}` | exact file present / any / none |
| `{"fileGlob":"g"}` / `{"anyFileGlob":[…]}` / `{"noneFileGlob":[…]}` | glob matches (supports `**`, `*`, `{a,b}`) |
| `{"config":"wrangler.toml:d1_databases"}` | parsed config fact present |
| `{"matched":"react-spa"}` | (recipes only) an archetype matched elsewhere in the repo |
| `{"always":true}` | unconditional (cross-cutting) |

Predicates must be **cheap and file-local** — the resolver never runs the project; it
reads manifests and file listings only. Deterministic in, deterministic out.

## 5. Editions

Standards are **versioned on change, not dated.** A new edition is cut only when best
practice materially shifts (a framework/tool major, a new consensus). Each edition carries
a **review date** so it can't silently rot:

```json
{ "version": "v1", "status": "latest",
  "reviewed": "2026-07", "nextReview": "2027-07",
  "targets": { "react": "19", "vite": "8", "tailwind": "4", "typescript": "6" } }
```

The resolver pins each applied standard to its `latest` edition (a repo may override with a
pin). A judge surfaces the review date as a **staleness signal**: *"judged against a
standard last verified N months ago."* An annual review that finds no change just bumps
`reviewed`.

## 6. The resolver

`resolve.mjs` is the reference implementation (dependency-free, Node 18+):

```
node resolve.mjs <repo-path> [--json]
```

Algorithm: slice the repo (§3) → gather signals per slice (§4) → for each slice, match the
one archetype + any layers + applicable cross-cutting → match repo-level recipes → pin
editions → emit a per-slice standard set **and a GAPS report** of matched-but-unauthored
standards, ranked by how many slices demand them.

`status: "planned"` entries are intentional: the resolver maps a slice to the *right*
standard even before its KB exists, so the GAPS report becomes a **demand-ranked authoring
backlog** driven by real repos rather than guesswork.

## 7. How a judge consumes this

```
1. resolve(repo)                  → per-slice { archetype, layers[], cross-cutting[] } @editions  + recipes
2. for each slice:
     fetch each standard's pinned edition (Markdown rules, each rule = R-<AREA>-<n>
       with a machine-readable detection signal + an explicit anti-pattern)
     judge the slice's code ONLY against that set
3. emit findings that cite clause IDs (e.g. "fails R-DATA-1")
     + the standard's review date as a staleness note
```

Two consequences that make the vision real:

- **Ground truth, not memory.** The judge's rubric is a fixed, versioned, fetchable
  document — reproducible and auditable, not a model's recollection of a 2023 blog post.
- **Anti-patterns are first-class.** Every rule ships the ✅ *and* the ❌ (the red-flag /
  no-no), because a judge matches **violations**. The "what's bad" corpus is queryable on
  its own.

## 8. Worked example — `~/work/crm`

A single command classifies a real hybrid monorepo into its true composition:

```
# app             [frontend]  archetype: react-spa@v1
                              cross-cutting: typescript, security, testing, accessibility, dependencies
# app/functions   [functions] archetype: pages-fullstack [PLANNED]
                              layers: d1-database [PLANNED]
# packages/cli    [package]   archetype: node-service [PLANNED]
# packages/mcp-worker         archetype: worker-edge [PLANNED]
                              layers: mcp-server, zod-validation [PLANNED]
# packages/sdk    [package]   archetype: library [PLANNED]
Repo recipes: react-spa-on-cloudflare-pages [PLANNED]
```

Only `react-spa@v1` is published today; everything else is a mapped gap. The CRM isn't "a
stack that needs its own KB" — it's `react-spa` (done) + `pages-fullstack` + `d1-database`
+ `node-service` + `worker-edge` + `mcp-server` + `library` + cross-cutters, most of which
are reused by every other Cloudflare-Pages fullstack repo in the ecosystem.

## Files

| File | Role |
| --- | --- |
| `registry.json` | the standards catalog + detection predicates + editions |
| `resolve.mjs` | reference resolver: repo → per-slice standard set + gaps |
| `SCHEMA.md` | this document |

> The **standards** registry (which KB to *judge against*) is deliberately separate from
> `site/registry.json`, the **publishing** registry (which KB repos deploy where). Producer:
> FreeDocStore. Primary consumer: VibeCode QA.
