# Prompt - draft a Glossary section

## Tool-agnostic prompt

```
You are drafting the Glossary section of a project knowledge base. The
glossary defines terms specific to this project's domain so terminology
stays consistent across requirements, architecture, tickets, and code.

Use ONLY information present in the provided context (briefs, transcripts,
existing docs, conversations). Do NOT invent meanings - if the source
uses a term but never defines it, write a definition that captures how
the source USES the term, and mark it "[inferred from usage; confirm
with team]".

REQUIRED STRUCTURE:

1. <h1>Glossary</h1>
2. <p class="lede"> - one sentence explaining the page is the project's
   shared vocabulary, definitions tuned to this project specifically.
3. (Optional) one paragraph explaining conventions if relevant.
4. <dl> with <dt>/<dd> pairs:
   - Each <dt> has an id attribute matching a kebab-case version of the
     term: <dt id="risk-tier">risk tier</dt>
   - Each <dd> contains a 1-3 sentence definition specific to this
     project's domain. Do NOT use generic dictionary definitions.
   - Where the source provides a concrete example, include it as
     <strong>Example:</strong> on a new line.
   - Where the source mentions other names for the same concept, list
     them as <strong>Synonyms:</strong> and note that callers should
     use the canonical term.
5. Terms are listed in alphabetical order.

RULES:
- HTML only. Use <dl>, <dt>, <dd> for the term/definition pairs - this
  is the semantically correct element for glossaries.
- Each definition must be specific to THIS project. "Case: a particular
  instance" is wrong; "Case: a record of an interaction with one client,
  encompassing intake, ongoing work, and closure, owned by exactly one
  caseworker at a time" is right.
- Do NOT define a term using the term itself.
- Do NOT include terms that are not used in the project's other docs.
  The glossary is for terms that actually appear in requirements,
  architecture, code, or tickets - not a general industry dictionary.
- Output is a complete <article class="doc"> ready for docs/glossary.html.
```

## Per-tool notes

### Claude

- Claude is excellent at extracting terms from a corpus. Paste several
  source docs (requirements, transcripts, an existing brief) and ask
  Claude to identify terms that appear repeatedly with non-trivial
  domain meaning. The first pass produces a candidate list; review
  before producing definitions.
- For projects with strong domain language (regulated industries,
  scientific work), Claude's domain knowledge is reliable as long as
  the prompt grounds it in the project's actual usage rather than
  defaulting to industry-standard meanings.

### ChatGPT / Codex

- Same prompt works on GPT-4 and later.
- GPT models occasionally invent terms that "should" exist in a domain
  but do not appear in the source. Reinforce: *"Only include terms that
  literally appear in the provided source material. Do not add terms
  the source does not mention."*

### Gemini

- Add: *"Output ONLY the &lt;article&gt; element."* Gemini sometimes
  prefaces glossaries with explanatory text.
- Gemini is particularly strong at extracting terms from technical
  source material; use Gemini Advanced if available for the first pass
  on a complex domain.

### Universal tweaks

- **Two passes.** Pass 1: identify the terms. Pass 2: write the
  definitions. Mixing these in one shot leads to either short term lists
  with rich definitions or long term lists with shallow definitions;
  splitting gets you both.
- **Pass the existing docs as context.** A glossary written without
  reference to existing requirements and architecture will define
  terms in ways that conflict with how those terms are already used.
  Always feed the glossary draft the most-current versions of related
  docs.
- **Confirm inferred meanings.** Terms tagged "[inferred from usage]"
  are exactly the terms the team needs to confirm. Treat them as a
  to-do list for a 30-minute team review session.
- **Re-feed the glossary to other prompts.** Once stable, paste the
  glossary as context when prompting any other section. Significantly
  improves vocabulary consistency across the rest of the KB.
