export function deployWorkflow(project: string, customDomain: string, options: { branch?: string; managed?: boolean } = {}) {
  const branch = options.branch ?? 'main'
  if (branch.includes('${{')) throw new Error('Choose a branch name without workflow expressions.')
  const domains = [...(options.managed ? [] : [`${project}.freedocstore.online`]), ...(customDomain ? [customDomain] : [])].join(' ')
  return `name: Deploy Zensical KB

on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-zensical
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      PRODUCTION_BRANCH: ${JSON.stringify(branch)}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: python -m pip install zensical==0.0.74
      - run: python -m zensical build --strict
      - name: Fetch FreeDocStore reader
        uses: actions/checkout@v7
        with:
          repository: FreeDocStore/platform
          path: _freedocstore
          sparse-checkout: |
            templates/read-aloud
            templates/publishing
      - name: Install published-page read aloud
        run: node _freedocstore/templates/read-aloud/install.mjs site
      - name: Write deployment identity
        env:
          PROJECT: ${project}
        run: |
          mkdir -p site/.well-known
          node -e 'require("node:fs").writeFileSync("site/.well-known/freedocstore.json", JSON.stringify({repo:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA,project:process.env.PROJECT}))'
      - name: Ensure Cloudflare Pages project
        run: node _freedocstore/templates/publishing/cloudflare.mjs project
        env:
          PROJECT: ${project}
          PRODUCTION_BRANCH: ${JSON.stringify(branch)}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Deploy to Cloudflare Pages
        run: npx --yes wrangler@4.107.0 pages deploy site --project-name="${project}" --branch="$PRODUCTION_BRANCH"
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Attach domains
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PROJECT: ${project}
          PRODUCTION_BRANCH: ${JSON.stringify(branch)}
          DOMAINS: ${domains}
        run: node _freedocstore/templates/publishing/cloudflare.mjs domains
`
}
