// Shared bundler for tests. Turns a .ts entry point into an importable
// ESM file so tests can exercise the real source without needing the
// full extension build.

import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, ".test-bundles");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

/** Bundle an entry point. Returns a file:// URL to import(). */
export async function bundle(relativeEntry) {
  const name = relativeEntry.replace(/[\/\\]/g, "_").replace(/\.ts$/, ".mjs");
  const outfile = resolve(OUT_DIR, name);
  await build({
    entryPoints: [resolve(ROOT, relativeEntry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  return outfile;
}
