# Brand & Documentation Style Guide

## Voice & Tone

- **Clear over clever** - Write for someone scanning, not studying.
- **Direct** - Lead with what matters. Skip filler.
- **Friendly but professional** - Approachable, not casual. No slang, no jargon without explanation.
- **Confident** - State things plainly. Avoid hedging ("maybe", "it should", "probably").

## Formatting Standards

### Headings

- Use `#` for the project name (one per file)
- Use `##` for major sections
- Use `###` for subsections
- Don't skip levels (no `#` then `###`)
- Use Title Case for headings

### Code

- Use fenced code blocks with language identifiers:
  ````
  ```bash
  pnpm install
  ```
  ````
- Inline code for file names, commands, variables: `pnpm dev`, `src/lib/auth.ts`

### Lists

- Use `-` for unordered lists (not `*`)
- Use `1.` for ordered/sequential steps
- Keep list items parallel in structure

### Tables

Use tables for structured comparisons (tech stack, environment variables, API endpoints).

### Punctuation

- **Avoid em dashes (—) in running text.** They are the single biggest tell of AI-generated copy. Use a full stop, colon, comma, or parentheses instead. See the [Writing page](../docs/writing.html) on the published site for the full guide.
- En dashes (–) are fine in **ranges only**: `2024–2026`, `10–15h`. Don't use them as punctuation.
- When you need a light break and nothing else fits, use a hyphen with spaces ( - ).

### Links

- Use descriptive link text: [contributing guide](CONTRIBUTING.md), not [click here](CONTRIBUTING.md)

## README Structure (Required Sections)

Every project README must include, in this order:

1. **Title** - Project name as `h1`
2. **One-liner** - What it does in one sentence
3. **Overview** - 2-3 sentences of context
4. **Getting Started** - Prerequisites, install, run
5. **Tech Stack** - Table format

Optional sections (add as needed):

6. **Project Structure** - Directory layout
7. **Contributing** - Link to CONTRIBUTING.md
8. **License**

## Visual Identity

### Logo Usage

- Canonical logos: `brand/assets/logo.svg` and `brand/assets/favicon.svg`
- Use `fetch-brand-assets: true` in the deploy workflow to pull logo, favicon, and stylesheet automatically
- SVG for web (all sites), PNG only if a specific tool requires it
- Maintain clear space around logos (minimum 1x the logo height)

#### Topbar Logo

Every doc site uses the Rocket Lab wordmark in the topbar, rendered as a white SVG:

```html
<a href="index.html"><img src="logo.svg" alt="Rocket Lab" class="topbar-logo"></a>
```

```css
.topbar-logo { height: 20px; margin-right: 10px; filter: brightness(0) invert(1); }
.topbar h1 a:hover .topbar-logo { filter: brightness(0) invert(1) sepia(1) saturate(50) hue-rotate(120deg); }
```

The logo inverts to white (`brightness(0) invert(1)`) on the dark topbar and shifts to accent green on hover.

### Colors

```
--bg:         #0f1117    Page background
--surface:    #181b24    Cards, sidebar
--surface2:   #1e2230    Table headers, code blocks
--border:     #2a2e3d    Borders and dividers
--text:       #e1e4ed    Primary text
--text-muted: #8b90a0    Secondary text, nav links
--accent:     #06f4b1    Links, highlights, active states (Rocket Lab green)
--accent-dim: #0ab882    Dimmed accent
```

The accent green `#06f4b1` is the Rocket Lab brand color - used in the logo, links, active states, tags, and callout borders.

## File Naming

- Documentation files: `UPPERCASE.md` for root-level (README, CONTRIBUTING, CHANGELOG)
- Nested docs: `lowercase-kebab-case.md`
- Assets: `lowercase-kebab-case.{svg,png}`
