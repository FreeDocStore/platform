import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

// Keep the model lazy and serve the pinned ONNX runtime from our own origin.
const require = createRequire(import.meta.url)
const transformersRoot = dirname(require.resolve('@huggingface/transformers'))
const runtimeRoot = dirname(require.resolve('onnxruntime-web', { paths: [transformersRoot] }))
const runtimeFiles = readdirSync(runtimeRoot).filter(name => /^ort-wasm.*\.(?:mjs|wasm)$/.test(name))

export default defineConfig({
  plugins: [
    {
      name: 'audio-runtime',
      generateBundle() {
        for (const file of runtimeFiles) this.emitFile({ type: 'asset', fileName: `audio-runtime/${file}`, source: readFileSync(resolve(runtimeRoot, file)) })
      },
      configureServer(server) {
        server.middlewares.use('/audio-runtime', (req, res, next) => {
          const name = (req.url || '').split('?')[0].slice(1)
          if (!runtimeFiles.includes(name)) return next()
          res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          res.end(readFileSync(resolve(runtimeRoot, name)))
        })
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,json}'],
        globIgnores: ['audio-runtime/**', '**/worker-*.js', '**/kokoro-*.js', '**/transformers-*.js'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/\.pas\//],
      },
      manifest: {
        name: 'FreeDocStore Editor',
        short_name: 'FDS Editor',
        description: 'Self-serve Zensical knowledge-base publishing on FreeDocStore',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f7fa',
        theme_color: '#111827',
        orientation: 'any',
        ...({ min_viewport_width: 360 } as Record<string, unknown>),
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: { host: true },
})
