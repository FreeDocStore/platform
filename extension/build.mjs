// Bundle the extension's TypeScript entry points into dist/.
// Intentionally tiny - no webpack, no rollup. esbuild is enough.
//
// Watch mode (`npm run dev`):
//   1. esbuild rebuilds .ts on change.
//   2. fs.watch re-copies STATIC files (manifest, HTML, CSS, icons) on change.
//   3. Every rebuild touches dist/.dev-build with a fresh timestamp.
//      The service worker polls that file and calls chrome.runtime.reload()
//      when the stamp changes, so Chrome picks up the new code without
//      a manual click in chrome://extensions.
import { build, context } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, watch as fsWatch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = resolve(ROOT, "dist");

const ENTRIES = [
  // Background service worker loads as an ES module (manifest has
  // "type": "module").
  { in: "src/background/service-worker.ts", out: "background.js", format: "esm" },
  // Content scripts in MV3 are classic scripts - ESM doesn't execute.
  // IIFE wraps everything and runs at injection time.
  { in: "src/content/content.ts", out: "content.js", format: "iife" },
  // Side panel HTML loads sidepanel.js with <script type="module">.
  { in: "src/sidepanel/sidepanel.ts", out: "sidepanel.js", format: "esm" },
  // Options page loads options.js with <script type="module">.
  { in: "src/options/options.ts", out: "options.js", format: "esm" },
  // Tasks board (full-tab page), loads board.js with <script type="module">.
  { in: "src/board/board.ts", out: "board.js", format: "esm" },
];

const STATIC = [
  { from: "manifest.json", to: "manifest.json" },
  { from: "src/sidepanel/sidepanel.html", to: "sidepanel.html" },
  { from: "src/sidepanel/sidepanel.css", to: "sidepanel.css" },
  { from: "src/options/options.html", to: "options.html" },
  { from: "src/options/options.css", to: "options.css" },
  { from: "src/board/board.html", to: "board.html" },
  { from: "src/board/board.css", to: "board.css" },
  { from: "icons", to: "icons" },
];

const watch = process.argv.includes("--watch");

async function copyStatic() {
  await mkdir(DIST, { recursive: true });
  for (const { from, to } of STATIC) {
    const src = resolve(ROOT, from);
    if (!existsSync(src)) continue;
    await cp(src, resolve(DIST, to), { recursive: true });
  }
}

// Written on every build pass in watch mode. The service worker polls
// this file (via chrome.runtime.getURL) and calls chrome.runtime.reload()
// when the stamp changes. In production builds the file is absent, so
// the poll 404s and the auto-reload loop is a no-op.
async function stampDev() {
  await writeFile(resolve(DIST, ".dev-build"), String(Date.now()));
}

// esbuild plugin: run stampDev after every successful rebuild, so a
// .ts edit alone triggers the extension reload (not just static-file
// edits).
const stampPlugin = {
  name: "dev-stamp",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return; // don't reload on a broken build
      void stampDev();
    });
  },
};

async function run() {
  await copyStatic();

  const baseOpts = {
    bundle: true,
    target: "chrome120",
    platform: "browser",
    sourcemap: true,
    logLevel: "info",
  };

  const ctxs = await Promise.all(
    ENTRIES.map((e) => {
      const opts = {
        ...baseOpts,
        format: e.format,
        entryPoints: [e.in],
        outfile: resolve(DIST, e.out),
        ...(watch ? { plugins: [stampPlugin] } : {}),
      };
      return watch ? context(opts) : build(opts);
    })
  );

  if (watch) {
    for (const c of ctxs) await c.watch();

    // Watch static files too - esbuild only cares about .ts, so HTML /
    // CSS / manifest / icon edits would otherwise go unnoticed.
    // Debounce: fs.watch fires twice on many editors (atomic-save
    // followed by rename), so we coalesce into one copy + stamp.
    let timer = null;
    const scheduleCopy = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        await copyStatic();
        await stampDev();
        console.log("Static files updated.");
      }, 80);
    };
    for (const { from } of STATIC) {
      const src = resolve(ROOT, from);
      if (!existsSync(src)) continue;
      fsWatch(src, { recursive: true }, scheduleCopy);
    }

    await stampDev();
    console.log("Watching for changes... (ts + static + dev-stamp)");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
