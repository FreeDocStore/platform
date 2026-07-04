# Prompt - draft a Decisions / ADRs section

## Tool-agnostic prompt

```
You are drafting Architecture Decision Records (ADRs) for a project's
knowledge base. Each ADR captures one non-obvious technical or product
choice, with the alternatives considered and the consequences.

Use ONLY information present in the provided context (design docs,
chat transcripts, prior decisions, code comments, conversations). Do
NOT invent rationale - if the context describes WHAT was chosen but not
WHY, write the Decision and add a "[gap: rationale not captured]"
marker in the Context subsection.

REQUIRED STRUCTURE for each ADR:

  <article id="adr-N">
    <h2>ADR-N. {Sentence-form title, e.g. "Use PostgreSQL for primary store"}</h2>
    <p><strong>Status:</strong> Proposed | Accepted | Deprecated | Superseded by ADR-M</p>
    <p><strong>Date:</strong> YYYY-MM-DD</p>

    <h3>Context</h3>
    <p>The situation that demanded a decision. 2-3 sentences.</p>

    <h3>Decision</h3>
    <p>What was chosen, in active voice. "We will use ..."</p>

    <h3>Consequences</h3>
    <p><strong>Easier:</strong></p>
    <ul><li>...</li></ul>
    <p><strong>Harder:</strong></p>
    <ul><li>...</li></ul>

    <h3>Alternatives considered</h3>
    <ul>
      <li><strong>{Alt 1}</strong> - {why rejected}</li>
      <li><strong>{Alt 2}</strong> - {why rejected}</li>
    </ul>
  </article>

PAGE STRUCTURE:
1. <h1>Decisions</h1>
2. <p class="lede"> - one sentence describing the page
3. <h2>Index</h2> - bullet list of ADR titles linking to anchors
4. Each ADR as an <article id="adr-N"> block, separated by <hr />.

RULES:
- HTML only.
- Numbering starts at 1 and is sequential. Numbers never get reused.
- Every ADR MUST have at least one entry under "Harder" in Consequences.
  Decisions with only positive consequences are usually under-thought.
- Every ADR MUST list at least one alternative considered. If the source
  material does not mention alternatives, write a plausible one and tag
  it "[likely candidate, not in source]".
- Status defaults to Accepted unless the source indicates otherwise.
- Keep each ADR to roughly 200-400 words. Longer entries usually contain
  implementation detail that belongs elsewhere (architecture, code).
- Do NOT include implementation specifics like function names, exact
  schemas, or library versions. ADRs record the choice, not the build.
- Output is a complete <article class="doc"> ready for docs/decisions.html.
```

## Per-tool notes

### Claude

- Excellent at extracting "why" from chat transcripts and design docs.
  Paste the source material in full; Claude can identify multiple distinct
  decisions in one pass and produce ADRs for each.
- For retroactive ADRs (decisions made earlier without documentation),
  ask Claude to mark them with "[retroactive]" in the status line so
  readers know the rationale was reconstructed.

### ChatGPT / Codex

- Same prompt works on GPT-4 and later.
- GPT models occasionally write the "Easier" subsection as a sales pitch
  and the "Harder" subsection as an afterthought. Reinforce: *"Both
  subsections must be equally specific. If you cannot name a concrete
  drawback, the decision was probably not worth an ADR."*

### Gemini

- Add: *"Output ONLY the &lt;article&gt; element - no preamble."*
- Gemini handles structured output well but occasionally adds extra
  status values (e.g., "Pending Review"). Constrain explicitly: status
  is one of *Proposed, Accepted, Deprecated,* or *Superseded by ADR-N*.

### Universal tweaks

- **One ADR per decision.** If a transcript covers six decisions, ask
  for six ADRs, not one combined ADR. Splitting matters because ADRs
  get superseded individually.
- **Date them.** Even retroactive ADRs should have a date (the date the
  decision was made, not the date it was written down). Adopters often
  forget; reinforce in the prompt if you see undated ADRs in output.
- **Keep titles searchable.** "Use PostgreSQL for primary store" is
  searchable. "Database decision" is not. Reinforce: *"Titles must
  contain the specific technology or pattern chosen, not just the topic."*
- **Prime with examples.** Pasting `examples/simple.html` improves
  consistency dramatically. ADRs are a learnable pattern but vary widely
  across teams; an example anchors the model to your preferred shape.
