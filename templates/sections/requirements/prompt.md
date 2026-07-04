# Prompt - draft a Requirements section

## Tool-agnostic prompt

Use this as your system or instruction prompt. Then provide the project material (brief, transcript, PRD draft, anything you have) as context.

```
You are drafting the Requirements section of a project knowledge base for a
software development project. The section will be the team's source of truth
for "what does this system need to do."

Your job is to produce a single Requirements page in HTML, following the
structure below. Use ONLY information present in the provided context - if
something is missing, do not invent it; instead, add it to the "Open questions"
list with a brief note about what is missing.

REQUIRED STRUCTURE (in this order, omit subsections that genuinely don't apply
but never invent content to fill them):

1. <h1>Requirements</h1>
2. A one-sentence lede in <p class="lede"> stating what the system delivers
3. <h2>Goals</h2> - 1-3 sentences on what success looks like from the
   stakeholder's perspective. Outcome-oriented, not feature lists.
4. <h2>Functional requirements</h2> - grouped by capability under <h3>.
   Each requirement has a stable ID (FR-1, FR-2, ...) and a MoSCoW priority
   in italics: (Must), (Should), (Could), (Won't).
5. <h2>Non-functional requirements</h2> - performance, security,
   accessibility, scale, observability, compliance. Group under <h3> by
   category. Each NFR has a measurable threshold ("p95 < 200 ms"), not vague
   adjectives ("should be fast").
6. <h2>Constraints</h2> - things the team can't change (budget, timeline,
   mandated stack, integrations).
7. <h2>Out of scope</h2> - explicit non-goals. This section is critical;
   if the context doesn't suggest any non-goals, add at least one or two
   plausible ones to prompt stakeholder confirmation.
8. <h2>Open questions</h2> - things the context doesn't answer. Each has
   an ID (Q-1, ...) and notes what's missing or who should decide.

RULES:
- HTML only. No markdown. Use <h1>/<h2>/<h3>, <p>, <ul>/<li>, <strong>, <em>.
- Don't include implementation details (those belong in the Architecture
  section). Requirements describe WHAT, not HOW.
- Don't include any opinions about feasibility - that's for the team to
  evaluate during estimation.
- If a requirement is genuinely vague in the source material, write what's
  there and add a Q to "Open questions" asking for the missing detail.
- The output is a complete <article class="doc"> element, ready to drop
  into docs/requirements.html.
```

## Per-tool notes

### Claude (claude.ai or API)

- Claude follows long structured prompts well. Paste the above as the system
  prompt and the project material as the user message.
- For projects with substantial source material (transcripts, briefs, prior
  PRDs), Claude's 200k+ context lets you include all of it in one shot.
- If the output truncates, ask Claude to continue from where it stopped. It
  will pick up the structure correctly.

### ChatGPT / Codex (chatgpt.com or OpenAI API)

- For GPT-4 and later, the same prompt works. Use a system message + user
  message split, same as Claude.
- For Codex CLI specifically: pass the prompt as `--instructions` and the
  source material as `--context`, then redirect the output to your file.
- GPT models occasionally drift to markdown if HTML-only is not emphasised -
  the prompt above repeats the rule to counter this.

### Gemini (gemini.google.com or API)

- Gemini handles HTML output well but is slightly more inclined to add
  preamble ("Here's the requirements page you asked for...") before the
  actual content. Add this line to the prompt: *"Output ONLY the
  &lt;article&gt; element - no preamble, no explanation, no closing remarks."*
- For Gemini Advanced with Deep Research, a single project brief in the
  context window plus this prompt produces solid first drafts.

### Universal tweaks

- **First draft, not final.** All three tools produce a usable starting
  point but you (or your team) edit before approving. The prompt is
  optimised for "fewest things to fix," not "publish without reading."
- **Iterate by section.** If you don't like the Constraints subsection,
  ask the tool to redo just that one - "rewrite only the Constraints
  subsection of the Requirements page, given [updated context]."
- **Prime with examples.** Pasting one of the `examples/` files in this
  folder as a "this is the shape of output I want" hint dramatically
  improves first-draft quality. Both Claude and Gemini respond well to
  one-shot examples; GPT benefits from two.
