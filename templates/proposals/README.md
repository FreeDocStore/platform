# Standalone proposals

This toolkit turns Markdown into a branded HTML proposal or a print-ready A4 PDF. It runs locally and does not load the FreeDocStore knowledge-base navigation shell. There is no in-app proposal body editor.

## Render

From the repository root:

```sh
node apps/editor/web/scripts/render-proposal.mjs \
  --input templates/proposals/example.md \
  --brand templates/proposals/brand.example.json \
  --output /tmp/example.html

node apps/editor/web/scripts/render-proposal.mjs \
  --input templates/proposals/example.md \
  --brand templates/proposals/brand.example.json \
  --output /tmp/example.pdf
```

PDF output uses Google Chrome in headless mode. Set `CHROME_BIN` to a Chrome-compatible executable when it is not at the default macOS location. HTML output is standalone and embeds the stylesheet and validated logo bytes.

Copy `proposal.md` and `brand.example.json` to a working directory. Replace the `{{...}}` authoring placeholders, customize brand values, and put an optional PNG, JPEG, or WebP logo beside the brand JSON. Logo paths must be relative to that JSON, resolve inside the same directory, and stay under 2 MiB. SVG, remote images, remote fonts, and external stylesheets are not loaded.

## Authoring features

Use GitHub-flavored Markdown headings, emphasis, lists, blockquotes, links, and tables. Raw HTML is shown as escaped text. Links with `https:` and `mailto:` destinations are clickable; other destinations are rendered as plain text. Markdown images are rendered as their alt text.

Proposal components use paired directives on their own lines:

```md
:::summary
A short executive summary.
:::

:::scope
### Included
- Work included in the fee.
:::

:::pricing
| Item | Amount |
| --- | ---: |
| Research | $1,000 |
:::

:::total
Total investment | $1,000
:::

:::signature
| Provider | Client |
| --- | --- |
| Signature: __________ | Signature: __________ |
:::

:::pagebreak
:::
```

Available components are `summary`, `scope`, `pricing`, `total`, `signature`, and `pagebreak`. Tables repeat their header rows in print. Scope and signature blocks and individual table rows avoid splitting across pages where the browser can honor the print rules. The explicit page break is useful before acceptance/signature sections.

## Checks

```sh
pnpm --dir apps/editor/web proposal:test
```

The tests cover escaping, unsafe links, brand value validation, local logo containment, reusable components, and A4/table/page-break styling.
