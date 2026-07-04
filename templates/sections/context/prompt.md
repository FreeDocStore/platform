# Prompt - draft a Context section

## Tool-agnostic prompt

```
You are drafting the Context section of a project knowledge base. This is
the orientation page - the first thing a new contributor reads to understand
why the project exists and who it is for.

Use ONLY information present in the provided context (briefs, transcripts,
interviews, prior docs). Do NOT invent stakeholders, motivations, or prior
art - if a section lacks source material, write what is there and add an
explicit "[gap]" marker noting what is missing.

REQUIRED STRUCTURE (in this order):

1. <h1>Context</h1>
2. A one-sentence lede in <p class="lede"> stating why the project exists
   and for whom.
3. <h2>Background</h2> - 1-3 paragraphs on the situation that demands the
   project. What problem exists, what has been tried, what changed recently.
4. <h2>Sponsor and stakeholders</h2>
   - <h3>Sponsor</h3> - who is accountable; state internal vs external
     explicitly; primary interest in one line.
   - <h3>Other stakeholders</h3> - bullet list. Each item has a name/role
     in <strong> and their concrete interest in one line.
5. <h2>Business motivation</h2> - the value created if this succeeds.
   Quantify when the source provides numbers; otherwise name the strategic
   outcome.
6. <h2>Adjacent systems and prior art</h2>
   - <h3>Existing systems</h3> - things this project replaces, integrates
     with, or lives next to.
   - <h3>Prior attempts</h3> - earlier internal projects on this problem,
     why they did not stick.
7. <h2>External constraints</h2> - things outside the team's control:
   regulatory, budget cycle, partnership commitments, org politics.
8. <h2>Definitions</h2> - critical terms, or a pointer to the Glossary.

RULES:
- HTML only. <h1>/<h2>/<h3>, <p>, <ul>/<li>, <strong>, <em>.
- Stakeholder lines must include their interest, not just their name.
  "Sarah, Head of Ops" is wrong; "Sarah, Head of Ops - cares about
  caseworker time-on-task; will block changes that increase it" is right.
- Do not mix in requirements ("the system shall...") - those belong on
  the Requirements page.
- Output is a complete <article class="doc"> ready for docs/context.html.
```

## Per-tool notes

### Claude

- Long structured prompts: paste the above as a system message; the project
  material as user message. Claude follows the "[gap]" instruction reliably.
- For interview transcripts, Claude is good at distilling each speaker's
  stakeholder interest from their own words - paste transcripts in full
  and let Claude attribute interests by speaker.

### ChatGPT / Codex

- Same prompt works on GPT-4 and later. Use system + user split.
- GPT models occasionally over-quantify ("an estimated 40% improvement")
  when the source is qualitative. Add to the prompt: *"Do NOT add numbers
  unless they appear in the source material."*

### Gemini

- Add: *"Output ONLY the &lt;article&gt; element - no preamble, no closing
  remarks."* Gemini sometimes wraps the output in commentary.
- Gemini handles long context windows well; for projects with multiple
  briefs, paste them all and ask for the synthesis.

### Universal tweaks

- **One-pass, then iterate.** The first draft is rarely the final. Common
  follow-ups: *"Rewrite the Stakeholders subsection - I missed Sarah from
  Ops, here is what she cares about: ..."*
- **Prime with an example.** Pasting `examples/simple.html` from this
  folder noticeably improves first-draft quality across all three tools.
- **Avoid hagiography.** AI tools default to flattering motivations
  ("This transformative initiative..."). Add to the prompt: *"Use neutral,
  factual language. Avoid superlatives."*
