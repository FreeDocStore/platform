# Prompt - draft an Architecture section

## Tool-agnostic prompt

```
You are drafting the Architecture section of a project knowledge base.
This page describes HOW the system is built - its components, data flow,
dependencies, and cross-cutting concerns. It is read by engineers before
they make changes and by operators when debugging incidents.

Use ONLY information present in the provided context (design docs,
existing code, runtime config, conversations). Do NOT invent components,
dependencies, or technology choices - if a section lacks source, write
what is known and add an explicit "[gap]" marker.

REQUIRED STRUCTURE (in this order):

1. <h1>Architecture</h1>
2. A one-sentence lede in <p class="lede"> describing the system shape.
3. <h2>Summary</h2> - one paragraph expanding the lede.
4. <h2>Components</h2> - one <h3> per component with a 4-bullet block:
   purpose, language/framework, depends on, owner.
5. <h2>System diagram</h2> - if visual content is available in the source,
   render as a Mermaid block (```mermaid ... ```). Otherwise produce a
   placeholder <p>[diagram pending]</p> and add an item to "Open
   questions" elsewhere.
6. <h2>Data flow</h2> - 1-2 key flows as <h3> with <ol> step lists.
7. <h2>External dependencies</h2> - bulleted list. Each entry: name,
   what it provides, where it runs, what happens when down.
8. <h2>Tech stack</h2> - bulleted list: language, runtime, framework,
   database, key libraries.
9. <h2>Deployment topology</h2> - cloud account/region, environments,
   ingress, data residency.
10. <h2>Cross-cutting concerns</h2> with <h3> for Security, Availability,
    Observability, Scale - high-level only, link out for detail.

RULES:
- HTML only. Mermaid blocks are allowed inside <pre><code class="language-mermaid">
  ... </code></pre>.
- Stay at the architecture level. Do NOT include function names, exact
  route paths, ORM model definitions - those belong in code or API docs.
- Do NOT include rationale for choices ("we chose X because..."). Rationale
  belongs on the Decisions page; reference it as "See ADR-N."
- Do NOT explain general technology basics (what PostgreSQL is, what HTTPS
  is). Assume the audience knows their craft.
- Output is a complete <article class="doc"> ready for docs/architecture.html.
```

## Per-tool notes

### Claude

- Claude is strong at component-level synthesis from source code. Paste
  the repo tree (or relevant subset) and Claude will produce accurate
  component descriptions.
- For Mermaid diagrams, Claude generates valid syntax reliably. Ask for
  a `flowchart LR` or `sequenceDiagram` block and it will produce
  working code.

### ChatGPT / Codex

- GPT-4 and later handle code -> architecture synthesis well. For very
  large repos, summarise the package layout first, then ask for the
  architecture page.
- GPT models occasionally include implementation specifics that should
  belong in code docs. Reinforce the rule: *"Do NOT include function names
  or exact API routes. Stay at the component level."*

### Gemini

- Gemini Advanced with code-aware mode handles repository synthesis well.
- For diagrams, Gemini sometimes outputs ASCII-art instead of Mermaid.
  Add: *"All diagrams MUST be Mermaid syntax in a code block, never
  ASCII art."*

### Universal tweaks

- **One component at a time.** For systems with many components, draft
  one component block at a time and combine. Models tend to lose
  precision when asked for 8 components in one shot.
- **Diagram is hardest to bootstrap.** Models can produce a Mermaid
  diagram from a clear component list but will hallucinate connections
  if asked to invent topology. Always provide the connection list
  explicitly or ask the model to list connections from source code first,
  then render.
- **Keep cross-cutting brief.** Security, Availability, Observability,
  Scale subsections want one paragraph each. If the model produces
  multi-paragraph essays, ask: *"Compress each cross-cutting subsection
  to one paragraph. Link to detailed docs rather than including detail."*
